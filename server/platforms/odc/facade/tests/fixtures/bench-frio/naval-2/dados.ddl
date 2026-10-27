/// Fixed domain for NvInspectionState.
create static entity NvInspectionState (Id Integer identifier required, Label Text(100) required, Order Integer required)
values Draft (Id=1, Label="Draft", Order=1), Scheduled (Id=2, Label="Scheduled", Order=2), Reviewed (Id=3, Label="Reviewed", Order=3), Closed (Id=4, Label="Closed", Order=4);
/// Fixed domain for NvSurveyState.
create static entity NvSurveyState (Id Integer identifier required, Label Text(100) required, Order Integer required)
values Draft (Id=1, Label="Draft", Order=1), Scheduled (Id=2, Label="Scheduled", Order=2), Reviewed (Id=3, Label="Reviewed", Order=3), Closed (Id=4, Label="Closed", Order=4);
/// Fixed domain for NvCertificationState.
create static entity NvCertificationState (Id Integer identifier required, Label Text(100) required, Order Integer required)
values Draft (Id=1, Label="Draft", Order=1), Scheduled (Id=2, Label="Scheduled", Order=2), Reviewed (Id=3, Label="Reviewed", Order=3), Closed (Id=4, Label="Closed", Order=4);
/// Fixed domain for NvAuditState.
create static entity NvAuditState (Id Integer identifier required, Label Text(100) required, Order Integer required)
values Draft (Id=1, Label="Draft", Order=1), Scheduled (Id=2, Label="Scheduled", Order=2), Reviewed (Id=3, Label="Reviewed", Order=3), Closed (Id=4, Label="Closed", Order=4);
/// Fixed domain for NvClaimState.
create static entity NvClaimState (Id Integer identifier required, Label Text(100) required, Order Integer required)
values Open (Id=1, Label="Open", Order=1), Assessed (Id=2, Label="Assessed", Order=2), Approved (Id=3, Label="Approved", Order=3), Settled (Id=4, Label="Settled", Order=4);
/// Fixed domain for NvRefundState.
create static entity NvRefundState (Id Integer identifier required, Label Text(100) required, Order Integer required)
values Open (Id=1, Label="Open", Order=1), Assessed (Id=2, Label="Assessed", Order=2), Approved (Id=3, Label="Approved", Order=3), Settled (Id=4, Label="Settled", Order=4);
/// Fixed domain for NvPenaltyState.
create static entity NvPenaltyState (Id Integer identifier required, Label Text(100) required, Order Integer required)
values Open (Id=1, Label="Open", Order=1), Assessed (Id=2, Label="Assessed", Order=2), Approved (Id=3, Label="Approved", Order=3), Settled (Id=4, Label="Settled", Order=4);
/// Fixed domain for NvRebateState.
create static entity NvRebateState (Id Integer identifier required, Label Text(100) required, Order Integer required)
values Open (Id=1, Label="Open", Order=1), Assessed (Id=2, Label="Assessed", Order=2), Approved (Id=3, Label="Approved", Order=3), Settled (Id=4, Label="Settled", Order=4);
/// Fixed domain for NvProvisionState.
create static entity NvProvisionState (Id Integer identifier required, Label Text(100) required, Order Integer required)
values Available (Id=1, Label="Available", Order=1), Held (Id=2, Label="Held", Order=2), Exhausted (Id=3, Label="Exhausted", Order=3), Expired (Id=4, Label="Expired", Order=4);
/// Fixed domain for NvSpareState.
create static entity NvSpareState (Id Integer identifier required, Label Text(100) required, Order Integer required)
values Available (Id=1, Label="Available", Order=1), Held (Id=2, Label="Held", Order=2), Exhausted (Id=3, Label="Exhausted", Order=3), Expired (Id=4, Label="Expired", Order=4);
/// Fixed domain for NvFuelState.
create static entity NvFuelState (Id Integer identifier required, Label Text(100) required, Order Integer required)
values Available (Id=1, Label="Available", Order=1), Held (Id=2, Label="Held", Order=2), Exhausted (Id=3, Label="Exhausted", Order=3), Expired (Id=4, Label="Expired", Order=4);
/// Fixed domain for NvCargoState.
create static entity NvCargoState (Id Integer identifier required, Label Text(100) required, Order Integer required)
values Available (Id=1, Label="Available", Order=1), Held (Id=2, Label="Held", Order=2), Exhausted (Id=3, Label="Exhausted", Order=3), Expired (Id=4, Label="Expired", Order=4);
/// Fixed domain for NvTrainingState.
create static entity NvTrainingState (Id Integer identifier required, Label Text(100) required, Order Integer required)
values Requested (Id=1, Label="Requested", Order=1), Planned (Id=2, Label="Planned", Order=2), Active (Id=3, Label="Active", Order=3), Finished (Id=4, Label="Finished", Order=4);
/// Fixed domain for NvShiftState.
create static entity NvShiftState (Id Integer identifier required, Label Text(100) required, Order Integer required)
values Requested (Id=1, Label="Requested", Order=1), Planned (Id=2, Label="Planned", Order=2), Active (Id=3, Label="Active", Order=3), Finished (Id=4, Label="Finished", Order=4);
/// Fixed domain for NvCredentialState.
create static entity NvCredentialState (Id Integer identifier required, Label Text(100) required, Order Integer required)
values Requested (Id=1, Label="Requested", Order=1), Planned (Id=2, Label="Planned", Order=2), Active (Id=3, Label="Active", Order=3), Finished (Id=4, Label="Finished", Order=4);
/// Fixed domain for NvLeaveState.
create static entity NvLeaveState (Id Integer identifier required, Label Text(100) required, Order Integer required)
values Requested (Id=1, Label="Requested", Order=1), Planned (Id=2, Label="Planned", Order=2), Active (Id=3, Label="Active", Order=3), Finished (Id=4, Label="Finished", Order=4);
/// Fixed domain for NvVoyageState.
create static entity NvVoyageState (Id Integer identifier required, Label Text(100) required, Order Integer required)
values Planned (Id=1, Label="Planned", Order=1), Ready (Id=2, Label="Ready", Order=2), Underway (Id=3, Label="Underway", Order=3), Completed (Id=4, Label="Completed", Order=4);
/// Fixed domain for NvDockingState.
create static entity NvDockingState (Id Integer identifier required, Label Text(100) required, Order Integer required)
values Planned (Id=1, Label="Planned", Order=1), Ready (Id=2, Label="Ready", Order=2), Underway (Id=3, Label="Underway", Order=3), Completed (Id=4, Label="Completed", Order=4);
/// Fixed domain for NvTowState.
create static entity NvTowState (Id Integer identifier required, Label Text(100) required, Order Integer required)
values Planned (Id=1, Label="Planned", Order=1), Ready (Id=2, Label="Ready", Order=2), Underway (Id=3, Label="Underway", Order=3), Completed (Id=4, Label="Completed", Order=4);
/// Fixed domain for NvTransferState.
create static entity NvTransferState (Id Integer identifier required, Label Text(100) required, Order Integer required)
values Planned (Id=1, Label="Planned", Order=1), Ready (Id=2, Label="Ready", Order=2), Underway (Id=3, Label="Underway", Order=3), Completed (Id=4, Label="Completed", Order=4);
/// Records used by NvInspection.
create entity NvInspection public (
/// Internal identity.
Id Long Integer identifier auto required,
/// Stores CreatedOn for NvInspection.
CreatedOn Date Time required,
/// Stores UpdatedOn for NvInspection.
UpdatedOn Date Time,
/// Stores Version for NvInspection.
Version Long Integer required default 1,
/// Stores Code for NvInspection.
Code Text(50) required,
/// Stores Name for NvInspection.
Name Text(200) required,
/// Stores CreatedBy for NvInspection.
CreatedBy User Identifier references User on delete Protect,
/// Stores DueOn for NvInspection.
DueOn Date required,
/// Stores Score for NvInspection.
Score Decimal(18,4),
/// Stores Limit for NvInspection.
Limit Decimal(18,4),
/// Stores Closed for NvInspection.
Closed Boolean,
/// Stores StateId for NvInspection.
StateId NvInspectionState Identifier required references NvInspectionState on delete Protect
);
create unique index UQ_1 on NvInspection (Code);
/// Records used by NvInspectionFinding.
create entity NvInspectionFinding public (
/// Internal identity.
Id Long Integer identifier auto required,
/// Stores CreatedOn for NvInspectionFinding.
CreatedOn Date Time required,
/// Stores UpdatedOn for NvInspectionFinding.
UpdatedOn Date Time,
/// Stores Version for NvInspectionFinding.
Version Long Integer required default 1,
/// Stores ParentId for NvInspectionFinding.
ParentId NvInspection Identifier required references NvInspection on delete Protect,
/// Stores Severity for NvInspectionFinding.
Severity Integer required,
/// Stores Description for NvInspectionFinding.
Description Text(1200) required,
/// Stores Resolved for NvInspectionFinding.
Resolved Boolean
);
create index IX_1 on NvInspectionFinding (ParentId, Severity);
/// Records used by NvInspectionEvidence.
create entity NvInspectionEvidence public (
/// Internal identity.
Id Long Integer identifier auto required,
/// Stores CreatedOn for NvInspectionEvidence.
CreatedOn Date Time required,
/// Stores UpdatedOn for NvInspectionEvidence.
UpdatedOn Date Time,
/// Stores Version for NvInspectionEvidence.
Version Long Integer required default 1,
/// Stores ParentId for NvInspectionEvidence.
ParentId NvInspection Identifier required references NvInspection on delete Protect,
/// Stores FileName for NvInspectionEvidence.
FileName Text(200) required,
/// Stores Digest for NvInspectionEvidence.
Digest Text(50) required,
/// Stores CapturedOn for NvInspectionEvidence.
CapturedOn Date Time required
);
/// Records used by NvInspectionAssignment.
create entity NvInspectionAssignment public (
/// Internal identity.
Id Long Integer identifier auto required,
/// Stores CreatedOn for NvInspectionAssignment.
CreatedOn Date Time required,
/// Stores UpdatedOn for NvInspectionAssignment.
UpdatedOn Date Time,
/// Stores Version for NvInspectionAssignment.
Version Long Integer required default 1,
/// Stores ParentId for NvInspectionAssignment.
ParentId NvInspection Identifier required references NvInspection on delete Protect,
/// Stores Assignee for NvInspectionAssignment.
Assignee User Identifier required references User on delete Protect,
/// Stores Hours for NvInspectionAssignment.
Hours Decimal(18,4) required,
/// Stores DueOn for NvInspectionAssignment.
DueOn Date required
);
/// Records used by NvInspectionDecision.
create entity NvInspectionDecision public (
/// Internal identity.
Id Long Integer identifier auto required,
/// Stores CreatedOn for NvInspectionDecision.
CreatedOn Date Time required,
/// Stores UpdatedOn for NvInspectionDecision.
UpdatedOn Date Time,
/// Stores Version for NvInspectionDecision.
Version Long Integer required default 1,
/// Stores ParentId for NvInspectionDecision.
ParentId NvInspection Identifier required references NvInspection on delete Protect,
/// Stores Reason for NvInspectionDecision.
Reason Text(800) required,
/// Stores Approved for NvInspectionDecision.
Approved Boolean,
/// Stores DecidedOn for NvInspectionDecision.
DecidedOn Date Time required
);
/// Records used by NvSurvey.
create entity NvSurvey public (
/// Internal identity.
Id Long Integer identifier auto required,
/// Stores CreatedOn for NvSurvey.
CreatedOn Date Time required,
/// Stores UpdatedOn for NvSurvey.
UpdatedOn Date Time,
/// Stores Version for NvSurvey.
Version Long Integer required default 1,
/// Stores Code for NvSurvey.
Code Text(50) required,
/// Stores Name for NvSurvey.
Name Text(200) required,
/// Stores CreatedBy for NvSurvey.
CreatedBy User Identifier references User on delete Protect,
/// Stores DueOn for NvSurvey.
DueOn Date required,
/// Stores Score for NvSurvey.
Score Decimal(18,4),
/// Stores Limit for NvSurvey.
Limit Decimal(18,4),
/// Stores Closed for NvSurvey.
Closed Boolean,
/// Stores StateId for NvSurvey.
StateId NvSurveyState Identifier required references NvSurveyState on delete Protect
);
create unique index UQ_1 on NvSurvey (Code);
/// Records used by NvSurveyFinding.
create entity NvSurveyFinding public (
/// Internal identity.
Id Long Integer identifier auto required,
/// Stores CreatedOn for NvSurveyFinding.
CreatedOn Date Time required,
/// Stores UpdatedOn for NvSurveyFinding.
UpdatedOn Date Time,
/// Stores Version for NvSurveyFinding.
Version Long Integer required default 1,
/// Stores ParentId for NvSurveyFinding.
ParentId NvSurvey Identifier required references NvSurvey on delete Protect,
/// Stores Severity for NvSurveyFinding.
Severity Integer required,
/// Stores Description for NvSurveyFinding.
Description Text(1200) required,
/// Stores Resolved for NvSurveyFinding.
Resolved Boolean
);
create index IX_1 on NvSurveyFinding (ParentId, Severity);
/// Records used by NvSurveyEvidence.
create entity NvSurveyEvidence public (
/// Internal identity.
Id Long Integer identifier auto required,
/// Stores CreatedOn for NvSurveyEvidence.
CreatedOn Date Time required,
/// Stores UpdatedOn for NvSurveyEvidence.
UpdatedOn Date Time,
/// Stores Version for NvSurveyEvidence.
Version Long Integer required default 1,
/// Stores ParentId for NvSurveyEvidence.
ParentId NvSurvey Identifier required references NvSurvey on delete Protect,
/// Stores FileName for NvSurveyEvidence.
FileName Text(200) required,
/// Stores Digest for NvSurveyEvidence.
Digest Text(50) required,
/// Stores CapturedOn for NvSurveyEvidence.
CapturedOn Date Time required
);
/// Records used by NvSurveyAssignment.
create entity NvSurveyAssignment public (
/// Internal identity.
Id Long Integer identifier auto required,
/// Stores CreatedOn for NvSurveyAssignment.
CreatedOn Date Time required,
/// Stores UpdatedOn for NvSurveyAssignment.
UpdatedOn Date Time,
/// Stores Version for NvSurveyAssignment.
Version Long Integer required default 1,
/// Stores ParentId for NvSurveyAssignment.
ParentId NvSurvey Identifier required references NvSurvey on delete Protect,
/// Stores Assignee for NvSurveyAssignment.
Assignee User Identifier required references User on delete Protect,
/// Stores Hours for NvSurveyAssignment.
Hours Decimal(18,4) required,
/// Stores DueOn for NvSurveyAssignment.
DueOn Date required
);
/// Records used by NvSurveyDecision.
create entity NvSurveyDecision public (
/// Internal identity.
Id Long Integer identifier auto required,
/// Stores CreatedOn for NvSurveyDecision.
CreatedOn Date Time required,
/// Stores UpdatedOn for NvSurveyDecision.
UpdatedOn Date Time,
/// Stores Version for NvSurveyDecision.
Version Long Integer required default 1,
/// Stores ParentId for NvSurveyDecision.
ParentId NvSurvey Identifier required references NvSurvey on delete Protect,
/// Stores Reason for NvSurveyDecision.
Reason Text(800) required,
/// Stores Approved for NvSurveyDecision.
Approved Boolean,
/// Stores DecidedOn for NvSurveyDecision.
DecidedOn Date Time required
);
/// Records used by NvCertification.
create entity NvCertification public (
/// Internal identity.
Id Long Integer identifier auto required,
/// Stores CreatedOn for NvCertification.
CreatedOn Date Time required,
/// Stores UpdatedOn for NvCertification.
UpdatedOn Date Time,
/// Stores Version for NvCertification.
Version Long Integer required default 1,
/// Stores Code for NvCertification.
Code Text(50) required,
/// Stores Name for NvCertification.
Name Text(200) required,
/// Stores CreatedBy for NvCertification.
CreatedBy User Identifier references User on delete Protect,
/// Stores DueOn for NvCertification.
DueOn Date required,
/// Stores Score for NvCertification.
Score Decimal(18,4),
/// Stores Limit for NvCertification.
Limit Decimal(18,4),
/// Stores Closed for NvCertification.
Closed Boolean,
/// Stores StateId for NvCertification.
StateId NvCertificationState Identifier required references NvCertificationState on delete Protect
);
create unique index UQ_1 on NvCertification (Code);
/// Records used by NvCertificationFinding.
create entity NvCertificationFinding public (
/// Internal identity.
Id Long Integer identifier auto required,
/// Stores CreatedOn for NvCertificationFinding.
CreatedOn Date Time required,
/// Stores UpdatedOn for NvCertificationFinding.
UpdatedOn Date Time,
/// Stores Version for NvCertificationFinding.
Version Long Integer required default 1,
/// Stores ParentId for NvCertificationFinding.
ParentId NvCertification Identifier required references NvCertification on delete Protect,
/// Stores Severity for NvCertificationFinding.
Severity Integer required,
/// Stores Description for NvCertificationFinding.
Description Text(1200) required,
/// Stores Resolved for NvCertificationFinding.
Resolved Boolean
);
create index IX_1 on NvCertificationFinding (ParentId, Severity);
/// Records used by NvCertificationEvidence.
create entity NvCertificationEvidence public (
/// Internal identity.
Id Long Integer identifier auto required,
/// Stores CreatedOn for NvCertificationEvidence.
CreatedOn Date Time required,
/// Stores UpdatedOn for NvCertificationEvidence.
UpdatedOn Date Time,
/// Stores Version for NvCertificationEvidence.
Version Long Integer required default 1,
/// Stores ParentId for NvCertificationEvidence.
ParentId NvCertification Identifier required references NvCertification on delete Protect,
/// Stores FileName for NvCertificationEvidence.
FileName Text(200) required,
/// Stores Digest for NvCertificationEvidence.
Digest Text(50) required,
/// Stores CapturedOn for NvCertificationEvidence.
CapturedOn Date Time required
);
/// Records used by NvCertificationAssignment.
create entity NvCertificationAssignment public (
/// Internal identity.
Id Long Integer identifier auto required,
/// Stores CreatedOn for NvCertificationAssignment.
CreatedOn Date Time required,
/// Stores UpdatedOn for NvCertificationAssignment.
UpdatedOn Date Time,
/// Stores Version for NvCertificationAssignment.
Version Long Integer required default 1,
/// Stores ParentId for NvCertificationAssignment.
ParentId NvCertification Identifier required references NvCertification on delete Protect,
/// Stores Assignee for NvCertificationAssignment.
Assignee User Identifier required references User on delete Protect,
/// Stores Hours for NvCertificationAssignment.
Hours Decimal(18,4) required,
/// Stores DueOn for NvCertificationAssignment.
DueOn Date required
);
/// Records used by NvCertificationDecision.
create entity NvCertificationDecision public (
/// Internal identity.
Id Long Integer identifier auto required,
/// Stores CreatedOn for NvCertificationDecision.
CreatedOn Date Time required,
/// Stores UpdatedOn for NvCertificationDecision.
UpdatedOn Date Time,
/// Stores Version for NvCertificationDecision.
Version Long Integer required default 1,
/// Stores ParentId for NvCertificationDecision.
ParentId NvCertification Identifier required references NvCertification on delete Protect,
/// Stores Reason for NvCertificationDecision.
Reason Text(800) required,
/// Stores Approved for NvCertificationDecision.
Approved Boolean,
/// Stores DecidedOn for NvCertificationDecision.
DecidedOn Date Time required
);
/// Records used by NvAudit.
create entity NvAudit public (
/// Internal identity.
Id Long Integer identifier auto required,
/// Stores CreatedOn for NvAudit.
CreatedOn Date Time required,
/// Stores UpdatedOn for NvAudit.
UpdatedOn Date Time,
/// Stores Version for NvAudit.
Version Long Integer required default 1,
/// Stores Code for NvAudit.
Code Text(50) required,
/// Stores Name for NvAudit.
Name Text(200) required,
/// Stores CreatedBy for NvAudit.
CreatedBy User Identifier references User on delete Protect,
/// Stores DueOn for NvAudit.
DueOn Date required,
/// Stores Score for NvAudit.
Score Decimal(18,4),
/// Stores Limit for NvAudit.
Limit Decimal(18,4),
/// Stores Closed for NvAudit.
Closed Boolean,
/// Stores StateId for NvAudit.
StateId NvAuditState Identifier required references NvAuditState on delete Protect
);
create unique index UQ_1 on NvAudit (Code);
/// Records used by NvAuditFinding.
create entity NvAuditFinding public (
/// Internal identity.
Id Long Integer identifier auto required,
/// Stores CreatedOn for NvAuditFinding.
CreatedOn Date Time required,
/// Stores UpdatedOn for NvAuditFinding.
UpdatedOn Date Time,
/// Stores Version for NvAuditFinding.
Version Long Integer required default 1,
/// Stores ParentId for NvAuditFinding.
ParentId NvAudit Identifier required references NvAudit on delete Protect,
/// Stores Severity for NvAuditFinding.
Severity Integer required,
/// Stores Description for NvAuditFinding.
Description Text(1200) required,
/// Stores Resolved for NvAuditFinding.
Resolved Boolean
);
create index IX_1 on NvAuditFinding (ParentId, Severity);
/// Records used by NvAuditEvidence.
create entity NvAuditEvidence public (
/// Internal identity.
Id Long Integer identifier auto required,
/// Stores CreatedOn for NvAuditEvidence.
CreatedOn Date Time required,
/// Stores UpdatedOn for NvAuditEvidence.
UpdatedOn Date Time,
/// Stores Version for NvAuditEvidence.
Version Long Integer required default 1,
/// Stores ParentId for NvAuditEvidence.
ParentId NvAudit Identifier required references NvAudit on delete Protect,
/// Stores FileName for NvAuditEvidence.
FileName Text(200) required,
/// Stores Digest for NvAuditEvidence.
Digest Text(50) required,
/// Stores CapturedOn for NvAuditEvidence.
CapturedOn Date Time required
);
/// Records used by NvAuditAssignment.
create entity NvAuditAssignment public (
/// Internal identity.
Id Long Integer identifier auto required,
/// Stores CreatedOn for NvAuditAssignment.
CreatedOn Date Time required,
/// Stores UpdatedOn for NvAuditAssignment.
UpdatedOn Date Time,
/// Stores Version for NvAuditAssignment.
Version Long Integer required default 1,
/// Stores ParentId for NvAuditAssignment.
ParentId NvAudit Identifier required references NvAudit on delete Protect,
/// Stores Assignee for NvAuditAssignment.
Assignee User Identifier required references User on delete Protect,
/// Stores Hours for NvAuditAssignment.
Hours Decimal(18,4) required,
/// Stores DueOn for NvAuditAssignment.
DueOn Date required
);
/// Records used by NvAuditDecision.
create entity NvAuditDecision public (
/// Internal identity.
Id Long Integer identifier auto required,
/// Stores CreatedOn for NvAuditDecision.
CreatedOn Date Time required,
/// Stores UpdatedOn for NvAuditDecision.
UpdatedOn Date Time,
/// Stores Version for NvAuditDecision.
Version Long Integer required default 1,
/// Stores ParentId for NvAuditDecision.
ParentId NvAudit Identifier required references NvAudit on delete Protect,
/// Stores Reason for NvAuditDecision.
Reason Text(800) required,
/// Stores Approved for NvAuditDecision.
Approved Boolean,
/// Stores DecidedOn for NvAuditDecision.
DecidedOn Date Time required
);
/// Records used by NvClaim.
create entity NvClaim public (
/// Internal identity.
Id Long Integer identifier auto required,
/// Stores CreatedOn for NvClaim.
CreatedOn Date Time required,
/// Stores UpdatedOn for NvClaim.
UpdatedOn Date Time,
/// Stores Version for NvClaim.
Version Long Integer required default 1,
/// Stores Code for NvClaim.
Code Text(50) required,
/// Stores Name for NvClaim.
Name Text(200) required,
/// Stores CreatedBy for NvClaim.
CreatedBy User Identifier references User on delete Protect,
/// Stores Amount for NvClaim.
Amount Decimal(18,2) required,
/// Stores Paid for NvClaim.
Paid Decimal(18,2),
/// Stores Ceiling for NvClaim.
Ceiling Decimal(18,2),
/// Stores Disputed for NvClaim.
Disputed Boolean,
/// Stores StateId for NvClaim.
StateId NvClaimState Identifier required references NvClaimState on delete Protect
);
create unique index UQ_1 on NvClaim (Code);
/// Records used by NvClaimCharge.
create entity NvClaimCharge public (
/// Internal identity.
Id Long Integer identifier auto required,
/// Stores CreatedOn for NvClaimCharge.
CreatedOn Date Time required,
/// Stores UpdatedOn for NvClaimCharge.
UpdatedOn Date Time,
/// Stores Version for NvClaimCharge.
Version Long Integer required default 1,
/// Stores ParentId for NvClaimCharge.
ParentId NvClaim Identifier required references NvClaim on delete Protect,
/// Stores Net for NvClaimCharge.
Net Decimal(18,2) required,
/// Stores Tax for NvClaimCharge.
Tax Decimal(18,2) required,
/// Stores DueOn for NvClaimCharge.
DueOn Date required
);
/// Records used by NvClaimAllocation.
create entity NvClaimAllocation public (
/// Internal identity.
Id Long Integer identifier auto required,
/// Stores CreatedOn for NvClaimAllocation.
CreatedOn Date Time required,
/// Stores UpdatedOn for NvClaimAllocation.
UpdatedOn Date Time,
/// Stores Version for NvClaimAllocation.
Version Long Integer required default 1,
/// Stores ParentId for NvClaimAllocation.
ParentId NvClaim Identifier required references NvClaim on delete Protect,
/// Stores Reference for NvClaimAllocation.
Reference Text(50) required,
/// Stores Value for NvClaimAllocation.
Value Decimal(18,2) required
);
create unique index UQ_1 on NvClaimAllocation (ParentId, Reference);
/// Records used by NvClaimReview.
create entity NvClaimReview public (
/// Internal identity.
Id Long Integer identifier auto required,
/// Stores CreatedOn for NvClaimReview.
CreatedOn Date Time required,
/// Stores UpdatedOn for NvClaimReview.
UpdatedOn Date Time,
/// Stores Version for NvClaimReview.
Version Long Integer required default 1,
/// Stores ParentId for NvClaimReview.
ParentId NvClaim Identifier required references NvClaim on delete Protect,
/// Stores Reviewer for NvClaimReview.
Reviewer User Identifier required references User on delete Protect,
/// Stores Accepted for NvClaimReview.
Accepted Boolean,
/// Stores Notes for NvClaimReview.
Notes Text(600)
);
/// Records used by NvClaimHistory.
create entity NvClaimHistory public (
/// Internal identity.
Id Long Integer identifier auto required,
/// Stores CreatedOn for NvClaimHistory.
CreatedOn Date Time required,
/// Stores UpdatedOn for NvClaimHistory.
UpdatedOn Date Time,
/// Stores Version for NvClaimHistory.
Version Long Integer required default 1,
/// Stores ParentId for NvClaimHistory.
ParentId NvClaim Identifier required references NvClaim on delete Protect,
/// Stores Previous for NvClaimHistory.
Previous Integer required,
/// Stores Next for NvClaimHistory.
Next Integer required,
/// Stores ChangedOn for NvClaimHistory.
ChangedOn Date Time required
);
/// Records used by NvRefund.
create entity NvRefund public (
/// Internal identity.
Id Long Integer identifier auto required,
/// Stores CreatedOn for NvRefund.
CreatedOn Date Time required,
/// Stores UpdatedOn for NvRefund.
UpdatedOn Date Time,
/// Stores Version for NvRefund.
Version Long Integer required default 1,
/// Stores Code for NvRefund.
Code Text(50) required,
/// Stores Name for NvRefund.
Name Text(200) required,
/// Stores CreatedBy for NvRefund.
CreatedBy User Identifier references User on delete Protect,
/// Stores Amount for NvRefund.
Amount Decimal(18,2) required,
/// Stores Paid for NvRefund.
Paid Decimal(18,2),
/// Stores Ceiling for NvRefund.
Ceiling Decimal(18,2),
/// Stores Disputed for NvRefund.
Disputed Boolean,
/// Stores StateId for NvRefund.
StateId NvRefundState Identifier required references NvRefundState on delete Protect
);
create unique index UQ_1 on NvRefund (Code);
/// Records used by NvRefundCharge.
create entity NvRefundCharge public (
/// Internal identity.
Id Long Integer identifier auto required,
/// Stores CreatedOn for NvRefundCharge.
CreatedOn Date Time required,
/// Stores UpdatedOn for NvRefundCharge.
UpdatedOn Date Time,
/// Stores Version for NvRefundCharge.
Version Long Integer required default 1,
/// Stores ParentId for NvRefundCharge.
ParentId NvRefund Identifier required references NvRefund on delete Protect,
/// Stores Net for NvRefundCharge.
Net Decimal(18,2) required,
/// Stores Tax for NvRefundCharge.
Tax Decimal(18,2) required,
/// Stores DueOn for NvRefundCharge.
DueOn Date required
);
/// Records used by NvRefundAllocation.
create entity NvRefundAllocation public (
/// Internal identity.
Id Long Integer identifier auto required,
/// Stores CreatedOn for NvRefundAllocation.
CreatedOn Date Time required,
/// Stores UpdatedOn for NvRefundAllocation.
UpdatedOn Date Time,
/// Stores Version for NvRefundAllocation.
Version Long Integer required default 1,
/// Stores ParentId for NvRefundAllocation.
ParentId NvRefund Identifier required references NvRefund on delete Protect,
/// Stores Reference for NvRefundAllocation.
Reference Text(50) required,
/// Stores Value for NvRefundAllocation.
Value Decimal(18,2) required
);
create unique index UQ_1 on NvRefundAllocation (ParentId, Reference);
/// Records used by NvRefundReview.
create entity NvRefundReview public (
/// Internal identity.
Id Long Integer identifier auto required,
/// Stores CreatedOn for NvRefundReview.
CreatedOn Date Time required,
/// Stores UpdatedOn for NvRefundReview.
UpdatedOn Date Time,
/// Stores Version for NvRefundReview.
Version Long Integer required default 1,
/// Stores ParentId for NvRefundReview.
ParentId NvRefund Identifier required references NvRefund on delete Protect,
/// Stores Reviewer for NvRefundReview.
Reviewer User Identifier required references User on delete Protect,
/// Stores Accepted for NvRefundReview.
Accepted Boolean,
/// Stores Notes for NvRefundReview.
Notes Text(600)
);
/// Records used by NvRefundHistory.
create entity NvRefundHistory public (
/// Internal identity.
Id Long Integer identifier auto required,
/// Stores CreatedOn for NvRefundHistory.
CreatedOn Date Time required,
/// Stores UpdatedOn for NvRefundHistory.
UpdatedOn Date Time,
/// Stores Version for NvRefundHistory.
Version Long Integer required default 1,
/// Stores ParentId for NvRefundHistory.
ParentId NvRefund Identifier required references NvRefund on delete Protect,
/// Stores Previous for NvRefundHistory.
Previous Integer required,
/// Stores Next for NvRefundHistory.
Next Integer required,
/// Stores ChangedOn for NvRefundHistory.
ChangedOn Date Time required
);
/// Records used by NvPenalty.
create entity NvPenalty public (
/// Internal identity.
Id Long Integer identifier auto required,
/// Stores CreatedOn for NvPenalty.
CreatedOn Date Time required,
/// Stores UpdatedOn for NvPenalty.
UpdatedOn Date Time,
/// Stores Version for NvPenalty.
Version Long Integer required default 1,
/// Stores Code for NvPenalty.
Code Text(50) required,
/// Stores Name for NvPenalty.
Name Text(200) required,
/// Stores CreatedBy for NvPenalty.
CreatedBy User Identifier references User on delete Protect,
/// Stores Amount for NvPenalty.
Amount Decimal(18,2) required,
/// Stores Paid for NvPenalty.
Paid Decimal(18,2),
/// Stores Ceiling for NvPenalty.
Ceiling Decimal(18,2),
/// Stores Disputed for NvPenalty.
Disputed Boolean,
/// Stores StateId for NvPenalty.
StateId NvPenaltyState Identifier required references NvPenaltyState on delete Protect
);
create unique index UQ_1 on NvPenalty (Code);
/// Records used by NvPenaltyCharge.
create entity NvPenaltyCharge public (
/// Internal identity.
Id Long Integer identifier auto required,
/// Stores CreatedOn for NvPenaltyCharge.
CreatedOn Date Time required,
/// Stores UpdatedOn for NvPenaltyCharge.
UpdatedOn Date Time,
/// Stores Version for NvPenaltyCharge.
Version Long Integer required default 1,
/// Stores ParentId for NvPenaltyCharge.
ParentId NvPenalty Identifier required references NvPenalty on delete Protect,
/// Stores Net for NvPenaltyCharge.
Net Decimal(18,2) required,
/// Stores Tax for NvPenaltyCharge.
Tax Decimal(18,2) required,
/// Stores DueOn for NvPenaltyCharge.
DueOn Date required
);
/// Records used by NvPenaltyAllocation.
create entity NvPenaltyAllocation public (
/// Internal identity.
Id Long Integer identifier auto required,
/// Stores CreatedOn for NvPenaltyAllocation.
CreatedOn Date Time required,
/// Stores UpdatedOn for NvPenaltyAllocation.
UpdatedOn Date Time,
/// Stores Version for NvPenaltyAllocation.
Version Long Integer required default 1,
/// Stores ParentId for NvPenaltyAllocation.
ParentId NvPenalty Identifier required references NvPenalty on delete Protect,
/// Stores Reference for NvPenaltyAllocation.
Reference Text(50) required,
/// Stores Value for NvPenaltyAllocation.
Value Decimal(18,2) required
);
create unique index UQ_1 on NvPenaltyAllocation (ParentId, Reference);
/// Records used by NvPenaltyReview.
create entity NvPenaltyReview public (
/// Internal identity.
Id Long Integer identifier auto required,
/// Stores CreatedOn for NvPenaltyReview.
CreatedOn Date Time required,
/// Stores UpdatedOn for NvPenaltyReview.
UpdatedOn Date Time,
/// Stores Version for NvPenaltyReview.
Version Long Integer required default 1,
/// Stores ParentId for NvPenaltyReview.
ParentId NvPenalty Identifier required references NvPenalty on delete Protect,
/// Stores Reviewer for NvPenaltyReview.
Reviewer User Identifier required references User on delete Protect,
/// Stores Accepted for NvPenaltyReview.
Accepted Boolean,
/// Stores Notes for NvPenaltyReview.
Notes Text(600)
);
/// Records used by NvPenaltyHistory.
create entity NvPenaltyHistory public (
/// Internal identity.
Id Long Integer identifier auto required,
/// Stores CreatedOn for NvPenaltyHistory.
CreatedOn Date Time required,
/// Stores UpdatedOn for NvPenaltyHistory.
UpdatedOn Date Time,
/// Stores Version for NvPenaltyHistory.
Version Long Integer required default 1,
/// Stores ParentId for NvPenaltyHistory.
ParentId NvPenalty Identifier required references NvPenalty on delete Protect,
/// Stores Previous for NvPenaltyHistory.
Previous Integer required,
/// Stores Next for NvPenaltyHistory.
Next Integer required,
/// Stores ChangedOn for NvPenaltyHistory.
ChangedOn Date Time required
);
/// Records used by NvRebate.
create entity NvRebate public (
/// Internal identity.
Id Long Integer identifier auto required,
/// Stores CreatedOn for NvRebate.
CreatedOn Date Time required,
/// Stores UpdatedOn for NvRebate.
UpdatedOn Date Time,
/// Stores Version for NvRebate.
Version Long Integer required default 1,
/// Stores Code for NvRebate.
Code Text(50) required,
/// Stores Name for NvRebate.
Name Text(200) required,
/// Stores CreatedBy for NvRebate.
CreatedBy User Identifier references User on delete Protect,
/// Stores Amount for NvRebate.
Amount Decimal(18,2) required,
/// Stores Paid for NvRebate.
Paid Decimal(18,2),
/// Stores Ceiling for NvRebate.
Ceiling Decimal(18,2),
/// Stores Disputed for NvRebate.
Disputed Boolean,
/// Stores StateId for NvRebate.
StateId NvRebateState Identifier required references NvRebateState on delete Protect
);
create unique index UQ_1 on NvRebate (Code);
/// Records used by NvRebateCharge.
create entity NvRebateCharge public (
/// Internal identity.
Id Long Integer identifier auto required,
/// Stores CreatedOn for NvRebateCharge.
CreatedOn Date Time required,
/// Stores UpdatedOn for NvRebateCharge.
UpdatedOn Date Time,
/// Stores Version for NvRebateCharge.
Version Long Integer required default 1,
/// Stores ParentId for NvRebateCharge.
ParentId NvRebate Identifier required references NvRebate on delete Protect,
/// Stores Net for NvRebateCharge.
Net Decimal(18,2) required,
/// Stores Tax for NvRebateCharge.
Tax Decimal(18,2) required,
/// Stores DueOn for NvRebateCharge.
DueOn Date required
);
/// Records used by NvRebateAllocation.
create entity NvRebateAllocation public (
/// Internal identity.
Id Long Integer identifier auto required,
/// Stores CreatedOn for NvRebateAllocation.
CreatedOn Date Time required,
/// Stores UpdatedOn for NvRebateAllocation.
UpdatedOn Date Time,
/// Stores Version for NvRebateAllocation.
Version Long Integer required default 1,
/// Stores ParentId for NvRebateAllocation.
ParentId NvRebate Identifier required references NvRebate on delete Protect,
/// Stores Reference for NvRebateAllocation.
Reference Text(50) required,
/// Stores Value for NvRebateAllocation.
Value Decimal(18,2) required
);
create unique index UQ_1 on NvRebateAllocation (ParentId, Reference);
/// Records used by NvRebateReview.
create entity NvRebateReview public (
/// Internal identity.
Id Long Integer identifier auto required,
/// Stores CreatedOn for NvRebateReview.
CreatedOn Date Time required,
/// Stores UpdatedOn for NvRebateReview.
UpdatedOn Date Time,
/// Stores Version for NvRebateReview.
Version Long Integer required default 1,
/// Stores ParentId for NvRebateReview.
ParentId NvRebate Identifier required references NvRebate on delete Protect,
/// Stores Reviewer for NvRebateReview.
Reviewer User Identifier required references User on delete Protect,
/// Stores Accepted for NvRebateReview.
Accepted Boolean,
/// Stores Notes for NvRebateReview.
Notes Text(600)
);
/// Records used by NvRebateHistory.
create entity NvRebateHistory public (
/// Internal identity.
Id Long Integer identifier auto required,
/// Stores CreatedOn for NvRebateHistory.
CreatedOn Date Time required,
/// Stores UpdatedOn for NvRebateHistory.
UpdatedOn Date Time,
/// Stores Version for NvRebateHistory.
Version Long Integer required default 1,
/// Stores ParentId for NvRebateHistory.
ParentId NvRebate Identifier required references NvRebate on delete Protect,
/// Stores Previous for NvRebateHistory.
Previous Integer required,
/// Stores Next for NvRebateHistory.
Next Integer required,
/// Stores ChangedOn for NvRebateHistory.
ChangedOn Date Time required
);
/// Records used by NvProvision.
create entity NvProvision public (
/// Internal identity.
Id Long Integer identifier auto required,
/// Stores CreatedOn for NvProvision.
CreatedOn Date Time required,
/// Stores UpdatedOn for NvProvision.
UpdatedOn Date Time,
/// Stores Version for NvProvision.
Version Long Integer required default 1,
/// Stores Code for NvProvision.
Code Text(50) required,
/// Stores Name for NvProvision.
Name Text(200) required,
/// Stores CreatedBy for NvProvision.
CreatedBy User Identifier references User on delete Protect,
/// Stores Quantity for NvProvision.
Quantity Decimal(18,4) required,
/// Stores Reserved for NvProvision.
Reserved Decimal(18,4),
/// Stores Capacity for NvProvision.
Capacity Decimal(18,4) required,
/// Stores UnitCost for NvProvision.
UnitCost Decimal(18,2) required,
/// Stores ValidUntil for NvProvision.
ValidUntil Date required,
/// Stores StateId for NvProvision.
StateId NvProvisionState Identifier required references NvProvisionState on delete Protect
);
create unique index UQ_1 on NvProvision (Code);
/// Records used by NvProvisionLot.
create entity NvProvisionLot public (
/// Internal identity.
Id Long Integer identifier auto required,
/// Stores CreatedOn for NvProvisionLot.
CreatedOn Date Time required,
/// Stores UpdatedOn for NvProvisionLot.
UpdatedOn Date Time,
/// Stores Version for NvProvisionLot.
Version Long Integer required default 1,
/// Stores ParentId for NvProvisionLot.
ParentId NvProvision Identifier required references NvProvision on delete Protect,
/// Stores BatchCode for NvProvisionLot.
BatchCode Text(50) required,
/// Stores Units for NvProvisionLot.
Units Decimal(18,4) required,
/// Stores Expiry for NvProvisionLot.
Expiry Date required
);
create unique index UQ_1 on NvProvisionLot (ParentId, BatchCode);
/// Records used by NvProvisionMovement.
create entity NvProvisionMovement public (
/// Internal identity.
Id Long Integer identifier auto required,
/// Stores CreatedOn for NvProvisionMovement.
CreatedOn Date Time required,
/// Stores UpdatedOn for NvProvisionMovement.
UpdatedOn Date Time,
/// Stores Version for NvProvisionMovement.
Version Long Integer required default 1,
/// Stores ParentId for NvProvisionMovement.
ParentId NvProvision Identifier required references NvProvision on delete Protect,
/// Stores Delta for NvProvisionMovement.
Delta Decimal(18,4) required,
/// Stores Reason for NvProvisionMovement.
Reason Text(200) required,
/// Stores OccurredOn for NvProvisionMovement.
OccurredOn Date Time required
);
/// Records used by NvProvisionReservation.
create entity NvProvisionReservation public (
/// Internal identity.
Id Long Integer identifier auto required,
/// Stores CreatedOn for NvProvisionReservation.
CreatedOn Date Time required,
/// Stores UpdatedOn for NvProvisionReservation.
UpdatedOn Date Time,
/// Stores Version for NvProvisionReservation.
Version Long Integer required default 1,
/// Stores ParentId for NvProvisionReservation.
ParentId NvProvision Identifier required references NvProvision on delete Protect,
/// Stores Units for NvProvisionReservation.
Units Decimal(18,4) required,
/// Stores ReleaseOn for NvProvisionReservation.
ReleaseOn Date required,
/// Stores Released for NvProvisionReservation.
Released Boolean
);
/// Records used by NvProvisionValuation.
create entity NvProvisionValuation public (
/// Internal identity.
Id Long Integer identifier auto required,
/// Stores CreatedOn for NvProvisionValuation.
CreatedOn Date Time required,
/// Stores UpdatedOn for NvProvisionValuation.
UpdatedOn Date Time,
/// Stores Version for NvProvisionValuation.
Version Long Integer required default 1,
/// Stores ParentId for NvProvisionValuation.
ParentId NvProvision Identifier required references NvProvision on delete Protect,
/// Stores UnitPrice for NvProvisionValuation.
UnitPrice Decimal(18,2) required,
/// Stores Currency for NvProvisionValuation.
Currency Text(50) required,
/// Stores EffectiveOn for NvProvisionValuation.
EffectiveOn Date required
);
/// Records used by NvSpare.
create entity NvSpare public (
/// Internal identity.
Id Long Integer identifier auto required,
/// Stores CreatedOn for NvSpare.
CreatedOn Date Time required,
/// Stores UpdatedOn for NvSpare.
UpdatedOn Date Time,
/// Stores Version for NvSpare.
Version Long Integer required default 1,
/// Stores Code for NvSpare.
Code Text(50) required,
/// Stores Name for NvSpare.
Name Text(200) required,
/// Stores CreatedBy for NvSpare.
CreatedBy User Identifier references User on delete Protect,
/// Stores Quantity for NvSpare.
Quantity Decimal(18,4) required,
/// Stores Reserved for NvSpare.
Reserved Decimal(18,4),
/// Stores Capacity for NvSpare.
Capacity Decimal(18,4) required,
/// Stores UnitCost for NvSpare.
UnitCost Decimal(18,2) required,
/// Stores ValidUntil for NvSpare.
ValidUntil Date required,
/// Stores StateId for NvSpare.
StateId NvSpareState Identifier required references NvSpareState on delete Protect
);
create unique index UQ_1 on NvSpare (Code);
/// Records used by NvSpareLot.
create entity NvSpareLot public (
/// Internal identity.
Id Long Integer identifier auto required,
/// Stores CreatedOn for NvSpareLot.
CreatedOn Date Time required,
/// Stores UpdatedOn for NvSpareLot.
UpdatedOn Date Time,
/// Stores Version for NvSpareLot.
Version Long Integer required default 1,
/// Stores ParentId for NvSpareLot.
ParentId NvSpare Identifier required references NvSpare on delete Protect,
/// Stores BatchCode for NvSpareLot.
BatchCode Text(50) required,
/// Stores Units for NvSpareLot.
Units Decimal(18,4) required,
/// Stores Expiry for NvSpareLot.
Expiry Date required
);
create unique index UQ_1 on NvSpareLot (ParentId, BatchCode);
/// Records used by NvSpareMovement.
create entity NvSpareMovement public (
/// Internal identity.
Id Long Integer identifier auto required,
/// Stores CreatedOn for NvSpareMovement.
CreatedOn Date Time required,
/// Stores UpdatedOn for NvSpareMovement.
UpdatedOn Date Time,
/// Stores Version for NvSpareMovement.
Version Long Integer required default 1,
/// Stores ParentId for NvSpareMovement.
ParentId NvSpare Identifier required references NvSpare on delete Protect,
/// Stores Delta for NvSpareMovement.
Delta Decimal(18,4) required,
/// Stores Reason for NvSpareMovement.
Reason Text(200) required,
/// Stores OccurredOn for NvSpareMovement.
OccurredOn Date Time required
);
/// Records used by NvSpareReservation.
create entity NvSpareReservation public (
/// Internal identity.
Id Long Integer identifier auto required,
/// Stores CreatedOn for NvSpareReservation.
CreatedOn Date Time required,
/// Stores UpdatedOn for NvSpareReservation.
UpdatedOn Date Time,
/// Stores Version for NvSpareReservation.
Version Long Integer required default 1,
/// Stores ParentId for NvSpareReservation.
ParentId NvSpare Identifier required references NvSpare on delete Protect,
/// Stores Units for NvSpareReservation.
Units Decimal(18,4) required,
/// Stores ReleaseOn for NvSpareReservation.
ReleaseOn Date required,
/// Stores Released for NvSpareReservation.
Released Boolean
);
/// Records used by NvSpareValuation.
create entity NvSpareValuation public (
/// Internal identity.
Id Long Integer identifier auto required,
/// Stores CreatedOn for NvSpareValuation.
CreatedOn Date Time required,
/// Stores UpdatedOn for NvSpareValuation.
UpdatedOn Date Time,
/// Stores Version for NvSpareValuation.
Version Long Integer required default 1,
/// Stores ParentId for NvSpareValuation.
ParentId NvSpare Identifier required references NvSpare on delete Protect,
/// Stores UnitPrice for NvSpareValuation.
UnitPrice Decimal(18,2) required,
/// Stores Currency for NvSpareValuation.
Currency Text(50) required,
/// Stores EffectiveOn for NvSpareValuation.
EffectiveOn Date required
);
/// Records used by NvFuel.
create entity NvFuel public (
/// Internal identity.
Id Long Integer identifier auto required,
/// Stores CreatedOn for NvFuel.
CreatedOn Date Time required,
/// Stores UpdatedOn for NvFuel.
UpdatedOn Date Time,
/// Stores Version for NvFuel.
Version Long Integer required default 1,
/// Stores Code for NvFuel.
Code Text(50) required,
/// Stores Name for NvFuel.
Name Text(200) required,
/// Stores CreatedBy for NvFuel.
CreatedBy User Identifier references User on delete Protect,
/// Stores Quantity for NvFuel.
Quantity Decimal(18,4) required,
/// Stores Reserved for NvFuel.
Reserved Decimal(18,4),
/// Stores Capacity for NvFuel.
Capacity Decimal(18,4) required,
/// Stores UnitCost for NvFuel.
UnitCost Decimal(18,2) required,
/// Stores ValidUntil for NvFuel.
ValidUntil Date required,
/// Stores StateId for NvFuel.
StateId NvFuelState Identifier required references NvFuelState on delete Protect
);
create unique index UQ_1 on NvFuel (Code);
/// Records used by NvFuelLot.
create entity NvFuelLot public (
/// Internal identity.
Id Long Integer identifier auto required,
/// Stores CreatedOn for NvFuelLot.
CreatedOn Date Time required,
/// Stores UpdatedOn for NvFuelLot.
UpdatedOn Date Time,
/// Stores Version for NvFuelLot.
Version Long Integer required default 1,
/// Stores ParentId for NvFuelLot.
ParentId NvFuel Identifier required references NvFuel on delete Protect,
/// Stores BatchCode for NvFuelLot.
BatchCode Text(50) required,
/// Stores Units for NvFuelLot.
Units Decimal(18,4) required,
/// Stores Expiry for NvFuelLot.
Expiry Date required
);
create unique index UQ_1 on NvFuelLot (ParentId, BatchCode);
/// Records used by NvFuelMovement.
create entity NvFuelMovement public (
/// Internal identity.
Id Long Integer identifier auto required,
/// Stores CreatedOn for NvFuelMovement.
CreatedOn Date Time required,
/// Stores UpdatedOn for NvFuelMovement.
UpdatedOn Date Time,
/// Stores Version for NvFuelMovement.
Version Long Integer required default 1,
/// Stores ParentId for NvFuelMovement.
ParentId NvFuel Identifier required references NvFuel on delete Protect,
/// Stores Delta for NvFuelMovement.
Delta Decimal(18,4) required,
/// Stores Reason for NvFuelMovement.
Reason Text(200) required,
/// Stores OccurredOn for NvFuelMovement.
OccurredOn Date Time required
);
/// Records used by NvFuelReservation.
create entity NvFuelReservation public (
/// Internal identity.
Id Long Integer identifier auto required,
/// Stores CreatedOn for NvFuelReservation.
CreatedOn Date Time required,
/// Stores UpdatedOn for NvFuelReservation.
UpdatedOn Date Time,
/// Stores Version for NvFuelReservation.
Version Long Integer required default 1,
/// Stores ParentId for NvFuelReservation.
ParentId NvFuel Identifier required references NvFuel on delete Protect,
/// Stores Units for NvFuelReservation.
Units Decimal(18,4) required,
/// Stores ReleaseOn for NvFuelReservation.
ReleaseOn Date required,
/// Stores Released for NvFuelReservation.
Released Boolean
);
/// Records used by NvFuelValuation.
create entity NvFuelValuation public (
/// Internal identity.
Id Long Integer identifier auto required,
/// Stores CreatedOn for NvFuelValuation.
CreatedOn Date Time required,
/// Stores UpdatedOn for NvFuelValuation.
UpdatedOn Date Time,
/// Stores Version for NvFuelValuation.
Version Long Integer required default 1,
/// Stores ParentId for NvFuelValuation.
ParentId NvFuel Identifier required references NvFuel on delete Protect,
/// Stores UnitPrice for NvFuelValuation.
UnitPrice Decimal(18,2) required,
/// Stores Currency for NvFuelValuation.
Currency Text(50) required,
/// Stores EffectiveOn for NvFuelValuation.
EffectiveOn Date required
);
/// Records used by NvCargo.
create entity NvCargo public (
/// Internal identity.
Id Long Integer identifier auto required,
/// Stores CreatedOn for NvCargo.
CreatedOn Date Time required,
/// Stores UpdatedOn for NvCargo.
UpdatedOn Date Time,
/// Stores Version for NvCargo.
Version Long Integer required default 1,
/// Stores Code for NvCargo.
Code Text(50) required,
/// Stores Name for NvCargo.
Name Text(200) required,
/// Stores CreatedBy for NvCargo.
CreatedBy User Identifier references User on delete Protect,
/// Stores Quantity for NvCargo.
Quantity Decimal(18,4) required,
/// Stores Reserved for NvCargo.
Reserved Decimal(18,4),
/// Stores Capacity for NvCargo.
Capacity Decimal(18,4) required,
/// Stores UnitCost for NvCargo.
UnitCost Decimal(18,2) required,
/// Stores ValidUntil for NvCargo.
ValidUntil Date required,
/// Stores StateId for NvCargo.
StateId NvCargoState Identifier required references NvCargoState on delete Protect
);
create unique index UQ_1 on NvCargo (Code);
/// Records used by NvCargoLot.
create entity NvCargoLot public (
/// Internal identity.
Id Long Integer identifier auto required,
/// Stores CreatedOn for NvCargoLot.
CreatedOn Date Time required,
/// Stores UpdatedOn for NvCargoLot.
UpdatedOn Date Time,
/// Stores Version for NvCargoLot.
Version Long Integer required default 1,
/// Stores ParentId for NvCargoLot.
ParentId NvCargo Identifier required references NvCargo on delete Protect,
/// Stores BatchCode for NvCargoLot.
BatchCode Text(50) required,
/// Stores Units for NvCargoLot.
Units Decimal(18,4) required,
/// Stores Expiry for NvCargoLot.
Expiry Date required
);
create unique index UQ_1 on NvCargoLot (ParentId, BatchCode);
/// Records used by NvCargoMovement.
create entity NvCargoMovement public (
/// Internal identity.
Id Long Integer identifier auto required,
/// Stores CreatedOn for NvCargoMovement.
CreatedOn Date Time required,
/// Stores UpdatedOn for NvCargoMovement.
UpdatedOn Date Time,
/// Stores Version for NvCargoMovement.
Version Long Integer required default 1,
/// Stores ParentId for NvCargoMovement.
ParentId NvCargo Identifier required references NvCargo on delete Protect,
/// Stores Delta for NvCargoMovement.
Delta Decimal(18,4) required,
/// Stores Reason for NvCargoMovement.
Reason Text(200) required,
/// Stores OccurredOn for NvCargoMovement.
OccurredOn Date Time required
);
/// Records used by NvCargoReservation.
create entity NvCargoReservation public (
/// Internal identity.
Id Long Integer identifier auto required,
/// Stores CreatedOn for NvCargoReservation.
CreatedOn Date Time required,
/// Stores UpdatedOn for NvCargoReservation.
UpdatedOn Date Time,
/// Stores Version for NvCargoReservation.
Version Long Integer required default 1,
/// Stores ParentId for NvCargoReservation.
ParentId NvCargo Identifier required references NvCargo on delete Protect,
/// Stores Units for NvCargoReservation.
Units Decimal(18,4) required,
/// Stores ReleaseOn for NvCargoReservation.
ReleaseOn Date required,
/// Stores Released for NvCargoReservation.
Released Boolean
);
/// Records used by NvCargoValuation.
create entity NvCargoValuation public (
/// Internal identity.
Id Long Integer identifier auto required,
/// Stores CreatedOn for NvCargoValuation.
CreatedOn Date Time required,
/// Stores UpdatedOn for NvCargoValuation.
UpdatedOn Date Time,
/// Stores Version for NvCargoValuation.
Version Long Integer required default 1,
/// Stores ParentId for NvCargoValuation.
ParentId NvCargo Identifier required references NvCargo on delete Protect,
/// Stores UnitPrice for NvCargoValuation.
UnitPrice Decimal(18,2) required,
/// Stores Currency for NvCargoValuation.
Currency Text(50) required,
/// Stores EffectiveOn for NvCargoValuation.
EffectiveOn Date required
);
/// Records used by NvTraining.
create entity NvTraining public (
/// Internal identity.
Id Long Integer identifier auto required,
/// Stores CreatedOn for NvTraining.
CreatedOn Date Time required,
/// Stores UpdatedOn for NvTraining.
UpdatedOn Date Time,
/// Stores Version for NvTraining.
Version Long Integer required default 1,
/// Stores Code for NvTraining.
Code Text(50) required,
/// Stores Name for NvTraining.
Name Text(200) required,
/// Stores CreatedBy for NvTraining.
CreatedBy User Identifier references User on delete Protect,
/// Stores Hours for NvTraining.
Hours Decimal(18,4) required,
/// Stores Completed for NvTraining.
Completed Decimal(18,4),
/// Stores Quota for NvTraining.
Quota Decimal(18,4) required,
/// Stores Deadline for NvTraining.
Deadline Date required,
/// Stores StateId for NvTraining.
StateId NvTrainingState Identifier required references NvTrainingState on delete Protect
);
create unique index UQ_1 on NvTraining (Code);
/// Records used by NvTrainingParticipant.
create entity NvTrainingParticipant public (
/// Internal identity.
Id Long Integer identifier auto required,
/// Stores CreatedOn for NvTrainingParticipant.
CreatedOn Date Time required,
/// Stores UpdatedOn for NvTrainingParticipant.
UpdatedOn Date Time,
/// Stores Version for NvTrainingParticipant.
Version Long Integer required default 1,
/// Stores ParentId for NvTrainingParticipant.
ParentId NvTraining Identifier required references NvTraining on delete Protect,
/// Stores Person for NvTrainingParticipant.
Person User Identifier required references User on delete Protect,
/// Stores Confirmed for NvTrainingParticipant.
Confirmed Boolean
);
create unique index UQ_1 on NvTrainingParticipant (ParentId, Person);
/// Records used by NvTrainingSession.
create entity NvTrainingSession public (
/// Internal identity.
Id Long Integer identifier auto required,
/// Stores CreatedOn for NvTrainingSession.
CreatedOn Date Time required,
/// Stores UpdatedOn for NvTrainingSession.
UpdatedOn Date Time,
/// Stores Version for NvTrainingSession.
Version Long Integer required default 1,
/// Stores ParentId for NvTrainingSession.
ParentId NvTraining Identifier required references NvTraining on delete Protect,
/// Stores StartOn for NvTrainingSession.
StartOn Date Time required,
/// Stores EndOn for NvTrainingSession.
EndOn Date Time required,
/// Stores Capacity for NvTrainingSession.
Capacity Integer required
);
/// Records used by NvTrainingAttendance.
create entity NvTrainingAttendance public (
/// Internal identity.
Id Long Integer identifier auto required,
/// Stores CreatedOn for NvTrainingAttendance.
CreatedOn Date Time required,
/// Stores UpdatedOn for NvTrainingAttendance.
UpdatedOn Date Time,
/// Stores Version for NvTrainingAttendance.
Version Long Integer required default 1,
/// Stores ParentId for NvTrainingAttendance.
ParentId NvTraining Identifier required references NvTraining on delete Protect,
/// Stores Person for NvTrainingAttendance.
Person User Identifier required references User on delete Protect,
/// Stores Minutes for NvTrainingAttendance.
Minutes Integer required,
/// Stores Excused for NvTrainingAttendance.
Excused Boolean
);
/// Records used by NvTrainingAssessment.
create entity NvTrainingAssessment public (
/// Internal identity.
Id Long Integer identifier auto required,
/// Stores CreatedOn for NvTrainingAssessment.
CreatedOn Date Time required,
/// Stores UpdatedOn for NvTrainingAssessment.
UpdatedOn Date Time,
/// Stores Version for NvTrainingAssessment.
Version Long Integer required default 1,
/// Stores ParentId for NvTrainingAssessment.
ParentId NvTraining Identifier required references NvTraining on delete Protect,
/// Stores Points for NvTrainingAssessment.
Points Decimal(18,4) required,
/// Stores Passed for NvTrainingAssessment.
Passed Boolean,
/// Stores Comment for NvTrainingAssessment.
Comment Text(800)
);
/// Records used by NvShift.
create entity NvShift public (
/// Internal identity.
Id Long Integer identifier auto required,
/// Stores CreatedOn for NvShift.
CreatedOn Date Time required,
/// Stores UpdatedOn for NvShift.
UpdatedOn Date Time,
/// Stores Version for NvShift.
Version Long Integer required default 1,
/// Stores Code for NvShift.
Code Text(50) required,
/// Stores Name for NvShift.
Name Text(200) required,
/// Stores CreatedBy for NvShift.
CreatedBy User Identifier references User on delete Protect,
/// Stores Hours for NvShift.
Hours Decimal(18,4) required,
/// Stores Completed for NvShift.
Completed Decimal(18,4),
/// Stores Quota for NvShift.
Quota Decimal(18,4) required,
/// Stores Deadline for NvShift.
Deadline Date required,
/// Stores StateId for NvShift.
StateId NvShiftState Identifier required references NvShiftState on delete Protect
);
create unique index UQ_1 on NvShift (Code);
/// Records used by NvShiftParticipant.
create entity NvShiftParticipant public (
/// Internal identity.
Id Long Integer identifier auto required,
/// Stores CreatedOn for NvShiftParticipant.
CreatedOn Date Time required,
/// Stores UpdatedOn for NvShiftParticipant.
UpdatedOn Date Time,
/// Stores Version for NvShiftParticipant.
Version Long Integer required default 1,
/// Stores ParentId for NvShiftParticipant.
ParentId NvShift Identifier required references NvShift on delete Protect,
/// Stores Person for NvShiftParticipant.
Person User Identifier required references User on delete Protect,
/// Stores Confirmed for NvShiftParticipant.
Confirmed Boolean
);
create unique index UQ_1 on NvShiftParticipant (ParentId, Person);
/// Records used by NvShiftSession.
create entity NvShiftSession public (
/// Internal identity.
Id Long Integer identifier auto required,
/// Stores CreatedOn for NvShiftSession.
CreatedOn Date Time required,
/// Stores UpdatedOn for NvShiftSession.
UpdatedOn Date Time,
/// Stores Version for NvShiftSession.
Version Long Integer required default 1,
/// Stores ParentId for NvShiftSession.
ParentId NvShift Identifier required references NvShift on delete Protect,
/// Stores StartOn for NvShiftSession.
StartOn Date Time required,
/// Stores EndOn for NvShiftSession.
EndOn Date Time required,
/// Stores Capacity for NvShiftSession.
Capacity Integer required
);
/// Records used by NvShiftAttendance.
create entity NvShiftAttendance public (
/// Internal identity.
Id Long Integer identifier auto required,
/// Stores CreatedOn for NvShiftAttendance.
CreatedOn Date Time required,
/// Stores UpdatedOn for NvShiftAttendance.
UpdatedOn Date Time,
/// Stores Version for NvShiftAttendance.
Version Long Integer required default 1,
/// Stores ParentId for NvShiftAttendance.
ParentId NvShift Identifier required references NvShift on delete Protect,
/// Stores Person for NvShiftAttendance.
Person User Identifier required references User on delete Protect,
/// Stores Minutes for NvShiftAttendance.
Minutes Integer required,
/// Stores Excused for NvShiftAttendance.
Excused Boolean
);
/// Records used by NvShiftAssessment.
create entity NvShiftAssessment public (
/// Internal identity.
Id Long Integer identifier auto required,
/// Stores CreatedOn for NvShiftAssessment.
CreatedOn Date Time required,
/// Stores UpdatedOn for NvShiftAssessment.
UpdatedOn Date Time,
/// Stores Version for NvShiftAssessment.
Version Long Integer required default 1,
/// Stores ParentId for NvShiftAssessment.
ParentId NvShift Identifier required references NvShift on delete Protect,
/// Stores Points for NvShiftAssessment.
Points Decimal(18,4) required,
/// Stores Passed for NvShiftAssessment.
Passed Boolean,
/// Stores Comment for NvShiftAssessment.
Comment Text(800)
);
/// Records used by NvCredential.
create entity NvCredential public (
/// Internal identity.
Id Long Integer identifier auto required,
/// Stores CreatedOn for NvCredential.
CreatedOn Date Time required,
/// Stores UpdatedOn for NvCredential.
UpdatedOn Date Time,
/// Stores Version for NvCredential.
Version Long Integer required default 1,
/// Stores Code for NvCredential.
Code Text(50) required,
/// Stores Name for NvCredential.
Name Text(200) required,
/// Stores CreatedBy for NvCredential.
CreatedBy User Identifier references User on delete Protect,
/// Stores Hours for NvCredential.
Hours Decimal(18,4) required,
/// Stores Completed for NvCredential.
Completed Decimal(18,4),
/// Stores Quota for NvCredential.
Quota Decimal(18,4) required,
/// Stores Deadline for NvCredential.
Deadline Date required,
/// Stores StateId for NvCredential.
StateId NvCredentialState Identifier required references NvCredentialState on delete Protect
);
create unique index UQ_1 on NvCredential (Code);
/// Records used by NvCredentialParticipant.
create entity NvCredentialParticipant public (
/// Internal identity.
Id Long Integer identifier auto required,
/// Stores CreatedOn for NvCredentialParticipant.
CreatedOn Date Time required,
/// Stores UpdatedOn for NvCredentialParticipant.
UpdatedOn Date Time,
/// Stores Version for NvCredentialParticipant.
Version Long Integer required default 1,
/// Stores ParentId for NvCredentialParticipant.
ParentId NvCredential Identifier required references NvCredential on delete Protect,
/// Stores Person for NvCredentialParticipant.
Person User Identifier required references User on delete Protect,
/// Stores Confirmed for NvCredentialParticipant.
Confirmed Boolean
);
create unique index UQ_1 on NvCredentialParticipant (ParentId, Person);
/// Records used by NvCredentialSession.
create entity NvCredentialSession public (
/// Internal identity.
Id Long Integer identifier auto required,
/// Stores CreatedOn for NvCredentialSession.
CreatedOn Date Time required,
/// Stores UpdatedOn for NvCredentialSession.
UpdatedOn Date Time,
/// Stores Version for NvCredentialSession.
Version Long Integer required default 1,
/// Stores ParentId for NvCredentialSession.
ParentId NvCredential Identifier required references NvCredential on delete Protect,
/// Stores StartOn for NvCredentialSession.
StartOn Date Time required,
/// Stores EndOn for NvCredentialSession.
EndOn Date Time required,
/// Stores Capacity for NvCredentialSession.
Capacity Integer required
);
/// Records used by NvCredentialAttendance.
create entity NvCredentialAttendance public (
/// Internal identity.
Id Long Integer identifier auto required,
/// Stores CreatedOn for NvCredentialAttendance.
CreatedOn Date Time required,
/// Stores UpdatedOn for NvCredentialAttendance.
UpdatedOn Date Time,
/// Stores Version for NvCredentialAttendance.
Version Long Integer required default 1,
/// Stores ParentId for NvCredentialAttendance.
ParentId NvCredential Identifier required references NvCredential on delete Protect,
/// Stores Person for NvCredentialAttendance.
Person User Identifier required references User on delete Protect,
/// Stores Minutes for NvCredentialAttendance.
Minutes Integer required,
/// Stores Excused for NvCredentialAttendance.
Excused Boolean
);
/// Records used by NvCredentialAssessment.
create entity NvCredentialAssessment public (
/// Internal identity.
Id Long Integer identifier auto required,
/// Stores CreatedOn for NvCredentialAssessment.
CreatedOn Date Time required,
/// Stores UpdatedOn for NvCredentialAssessment.
UpdatedOn Date Time,
/// Stores Version for NvCredentialAssessment.
Version Long Integer required default 1,
/// Stores ParentId for NvCredentialAssessment.
ParentId NvCredential Identifier required references NvCredential on delete Protect,
/// Stores Points for NvCredentialAssessment.
Points Decimal(18,4) required,
/// Stores Passed for NvCredentialAssessment.
Passed Boolean,
/// Stores Comment for NvCredentialAssessment.
Comment Text(800)
);
/// Records used by NvLeave.
create entity NvLeave public (
/// Internal identity.
Id Long Integer identifier auto required,
/// Stores CreatedOn for NvLeave.
CreatedOn Date Time required,
/// Stores UpdatedOn for NvLeave.
UpdatedOn Date Time,
/// Stores Version for NvLeave.
Version Long Integer required default 1,
/// Stores Code for NvLeave.
Code Text(50) required,
/// Stores Name for NvLeave.
Name Text(200) required,
/// Stores CreatedBy for NvLeave.
CreatedBy User Identifier references User on delete Protect,
/// Stores Hours for NvLeave.
Hours Decimal(18,4) required,
/// Stores Completed for NvLeave.
Completed Decimal(18,4),
/// Stores Quota for NvLeave.
Quota Decimal(18,4) required,
/// Stores Deadline for NvLeave.
Deadline Date required,
/// Stores StateId for NvLeave.
StateId NvLeaveState Identifier required references NvLeaveState on delete Protect
);
create unique index UQ_1 on NvLeave (Code);
/// Records used by NvLeaveParticipant.
create entity NvLeaveParticipant public (
/// Internal identity.
Id Long Integer identifier auto required,
/// Stores CreatedOn for NvLeaveParticipant.
CreatedOn Date Time required,
/// Stores UpdatedOn for NvLeaveParticipant.
UpdatedOn Date Time,
/// Stores Version for NvLeaveParticipant.
Version Long Integer required default 1,
/// Stores ParentId for NvLeaveParticipant.
ParentId NvLeave Identifier required references NvLeave on delete Protect,
/// Stores Person for NvLeaveParticipant.
Person User Identifier required references User on delete Protect,
/// Stores Confirmed for NvLeaveParticipant.
Confirmed Boolean
);
create unique index UQ_1 on NvLeaveParticipant (ParentId, Person);
/// Records used by NvLeaveSession.
create entity NvLeaveSession public (
/// Internal identity.
Id Long Integer identifier auto required,
/// Stores CreatedOn for NvLeaveSession.
CreatedOn Date Time required,
/// Stores UpdatedOn for NvLeaveSession.
UpdatedOn Date Time,
/// Stores Version for NvLeaveSession.
Version Long Integer required default 1,
/// Stores ParentId for NvLeaveSession.
ParentId NvLeave Identifier required references NvLeave on delete Protect,
/// Stores StartOn for NvLeaveSession.
StartOn Date Time required,
/// Stores EndOn for NvLeaveSession.
EndOn Date Time required,
/// Stores Capacity for NvLeaveSession.
Capacity Integer required
);
/// Records used by NvLeaveAttendance.
create entity NvLeaveAttendance public (
/// Internal identity.
Id Long Integer identifier auto required,
/// Stores CreatedOn for NvLeaveAttendance.
CreatedOn Date Time required,
/// Stores UpdatedOn for NvLeaveAttendance.
UpdatedOn Date Time,
/// Stores Version for NvLeaveAttendance.
Version Long Integer required default 1,
/// Stores ParentId for NvLeaveAttendance.
ParentId NvLeave Identifier required references NvLeave on delete Protect,
/// Stores Person for NvLeaveAttendance.
Person User Identifier required references User on delete Protect,
/// Stores Minutes for NvLeaveAttendance.
Minutes Integer required,
/// Stores Excused for NvLeaveAttendance.
Excused Boolean
);
/// Records used by NvLeaveAssessment.
create entity NvLeaveAssessment public (
/// Internal identity.
Id Long Integer identifier auto required,
/// Stores CreatedOn for NvLeaveAssessment.
CreatedOn Date Time required,
/// Stores UpdatedOn for NvLeaveAssessment.
UpdatedOn Date Time,
/// Stores Version for NvLeaveAssessment.
Version Long Integer required default 1,
/// Stores ParentId for NvLeaveAssessment.
ParentId NvLeave Identifier required references NvLeave on delete Protect,
/// Stores Points for NvLeaveAssessment.
Points Decimal(18,4) required,
/// Stores Passed for NvLeaveAssessment.
Passed Boolean,
/// Stores Comment for NvLeaveAssessment.
Comment Text(800)
);
/// Records used by NvVoyage.
create entity NvVoyage public (
/// Internal identity.
Id Long Integer identifier auto required,
/// Stores CreatedOn for NvVoyage.
CreatedOn Date Time required,
/// Stores UpdatedOn for NvVoyage.
UpdatedOn Date Time,
/// Stores Version for NvVoyage.
Version Long Integer required default 1,
/// Stores Code for NvVoyage.
Code Text(50) required,
/// Stores Name for NvVoyage.
Name Text(200) required,
/// Stores CreatedBy for NvVoyage.
CreatedBy User Identifier references User on delete Protect,
/// Stores Distance for NvVoyage.
Distance Decimal(18,4) required,
/// Stores Completed for NvVoyage.
Completed Decimal(18,4),
/// Stores MaxLoad for NvVoyage.
MaxLoad Decimal(18,4) required,
/// Stores CurrentLoad for NvVoyage.
CurrentLoad Decimal(18,4) required,
/// Stores Departure for NvVoyage.
Departure Date required,
/// Stores StateId for NvVoyage.
StateId NvVoyageState Identifier required references NvVoyageState on delete Protect
);
create unique index UQ_1 on NvVoyage (Code);
/// Records used by NvVoyageLeg.
create entity NvVoyageLeg public (
/// Internal identity.
Id Long Integer identifier auto required,
/// Stores CreatedOn for NvVoyageLeg.
CreatedOn Date Time required,
/// Stores UpdatedOn for NvVoyageLeg.
UpdatedOn Date Time,
/// Stores Version for NvVoyageLeg.
Version Long Integer required default 1,
/// Stores ParentId for NvVoyageLeg.
ParentId NvVoyage Identifier required references NvVoyage on delete Protect,
/// Stores Sequence for NvVoyageLeg.
Sequence Integer required,
/// Stores Origin for NvVoyageLeg.
Origin Text(200) required,
/// Stores Destination for NvVoyageLeg.
Destination Text(200) required,
/// Stores Distance for NvVoyageLeg.
Distance Decimal(18,4) required
);
create unique index UQ_1 on NvVoyageLeg (ParentId, Sequence);
/// Records used by NvVoyagePassenger.
create entity NvVoyagePassenger public (
/// Internal identity.
Id Long Integer identifier auto required,
/// Stores CreatedOn for NvVoyagePassenger.
CreatedOn Date Time required,
/// Stores UpdatedOn for NvVoyagePassenger.
UpdatedOn Date Time,
/// Stores Version for NvVoyagePassenger.
Version Long Integer required default 1,
/// Stores ParentId for NvVoyagePassenger.
ParentId NvVoyage Identifier required references NvVoyage on delete Protect,
/// Stores Name for NvVoyagePassenger.
Name Text(200) required,
/// Stores Contact for NvVoyagePassenger.
Contact Email,
/// Stores Weight for NvVoyagePassenger.
Weight Decimal(18,4) required
);
/// Records used by NvVoyageCheckpoint.
create entity NvVoyageCheckpoint public (
/// Internal identity.
Id Long Integer identifier auto required,
/// Stores CreatedOn for NvVoyageCheckpoint.
CreatedOn Date Time required,
/// Stores UpdatedOn for NvVoyageCheckpoint.
UpdatedOn Date Time,
/// Stores Version for NvVoyageCheckpoint.
Version Long Integer required default 1,
/// Stores ParentId for NvVoyageCheckpoint.
ParentId NvVoyage Identifier required references NvVoyage on delete Protect,
/// Stores ExpectedOn for NvVoyageCheckpoint.
ExpectedOn Date Time required,
/// Stores ObservedOn for NvVoyageCheckpoint.
ObservedOn Date Time,
/// Stores Confirmed for NvVoyageCheckpoint.
Confirmed Boolean
);
/// Records used by NvVoyageIncident.
create entity NvVoyageIncident public (
/// Internal identity.
Id Long Integer identifier auto required,
/// Stores CreatedOn for NvVoyageIncident.
CreatedOn Date Time required,
/// Stores UpdatedOn for NvVoyageIncident.
UpdatedOn Date Time,
/// Stores Version for NvVoyageIncident.
Version Long Integer required default 1,
/// Stores ParentId for NvVoyageIncident.
ParentId NvVoyage Identifier required references NvVoyage on delete Protect,
/// Stores Report for NvVoyageIncident.
Report Text(1600) required,
/// Stores Severity for NvVoyageIncident.
Severity Integer required,
/// Stores IsClosed for NvVoyageIncident.
IsClosed Boolean
);
/// Records used by NvDocking.
create entity NvDocking public (
/// Internal identity.
Id Long Integer identifier auto required,
/// Stores CreatedOn for NvDocking.
CreatedOn Date Time required,
/// Stores UpdatedOn for NvDocking.
UpdatedOn Date Time,
/// Stores Version for NvDocking.
Version Long Integer required default 1,
/// Stores Code for NvDocking.
Code Text(50) required,
/// Stores Name for NvDocking.
Name Text(200) required,
/// Stores CreatedBy for NvDocking.
CreatedBy User Identifier references User on delete Protect,
/// Stores Distance for NvDocking.
Distance Decimal(18,4) required,
/// Stores Completed for NvDocking.
Completed Decimal(18,4),
/// Stores MaxLoad for NvDocking.
MaxLoad Decimal(18,4) required,
/// Stores CurrentLoad for NvDocking.
CurrentLoad Decimal(18,4) required,
/// Stores Departure for NvDocking.
Departure Date required,
/// Stores StateId for NvDocking.
StateId NvDockingState Identifier required references NvDockingState on delete Protect
);
create unique index UQ_1 on NvDocking (Code);
/// Records used by NvDockingLeg.
create entity NvDockingLeg public (
/// Internal identity.
Id Long Integer identifier auto required,
/// Stores CreatedOn for NvDockingLeg.
CreatedOn Date Time required,
/// Stores UpdatedOn for NvDockingLeg.
UpdatedOn Date Time,
/// Stores Version for NvDockingLeg.
Version Long Integer required default 1,
/// Stores ParentId for NvDockingLeg.
ParentId NvDocking Identifier required references NvDocking on delete Protect,
/// Stores Sequence for NvDockingLeg.
Sequence Integer required,
/// Stores Origin for NvDockingLeg.
Origin Text(200) required,
/// Stores Destination for NvDockingLeg.
Destination Text(200) required,
/// Stores Distance for NvDockingLeg.
Distance Decimal(18,4) required
);
create unique index UQ_1 on NvDockingLeg (ParentId, Sequence);
/// Records used by NvDockingPassenger.
create entity NvDockingPassenger public (
/// Internal identity.
Id Long Integer identifier auto required,
/// Stores CreatedOn for NvDockingPassenger.
CreatedOn Date Time required,
/// Stores UpdatedOn for NvDockingPassenger.
UpdatedOn Date Time,
/// Stores Version for NvDockingPassenger.
Version Long Integer required default 1,
/// Stores ParentId for NvDockingPassenger.
ParentId NvDocking Identifier required references NvDocking on delete Protect,
/// Stores Name for NvDockingPassenger.
Name Text(200) required,
/// Stores Contact for NvDockingPassenger.
Contact Email,
/// Stores Weight for NvDockingPassenger.
Weight Decimal(18,4) required
);
/// Records used by NvDockingCheckpoint.
create entity NvDockingCheckpoint public (
/// Internal identity.
Id Long Integer identifier auto required,
/// Stores CreatedOn for NvDockingCheckpoint.
CreatedOn Date Time required,
/// Stores UpdatedOn for NvDockingCheckpoint.
UpdatedOn Date Time,
/// Stores Version for NvDockingCheckpoint.
Version Long Integer required default 1,
/// Stores ParentId for NvDockingCheckpoint.
ParentId NvDocking Identifier required references NvDocking on delete Protect,
/// Stores ExpectedOn for NvDockingCheckpoint.
ExpectedOn Date Time required,
/// Stores ObservedOn for NvDockingCheckpoint.
ObservedOn Date Time,
/// Stores Confirmed for NvDockingCheckpoint.
Confirmed Boolean
);
/// Records used by NvDockingIncident.
create entity NvDockingIncident public (
/// Internal identity.
Id Long Integer identifier auto required,
/// Stores CreatedOn for NvDockingIncident.
CreatedOn Date Time required,
/// Stores UpdatedOn for NvDockingIncident.
UpdatedOn Date Time,
/// Stores Version for NvDockingIncident.
Version Long Integer required default 1,
/// Stores ParentId for NvDockingIncident.
ParentId NvDocking Identifier required references NvDocking on delete Protect,
/// Stores Report for NvDockingIncident.
Report Text(1600) required,
/// Stores Severity for NvDockingIncident.
Severity Integer required,
/// Stores IsClosed for NvDockingIncident.
IsClosed Boolean
);
/// Records used by NvTow.
create entity NvTow public (
/// Internal identity.
Id Long Integer identifier auto required,
/// Stores CreatedOn for NvTow.
CreatedOn Date Time required,
/// Stores UpdatedOn for NvTow.
UpdatedOn Date Time,
/// Stores Version for NvTow.
Version Long Integer required default 1,
/// Stores Code for NvTow.
Code Text(50) required,
/// Stores Name for NvTow.
Name Text(200) required,
/// Stores CreatedBy for NvTow.
CreatedBy User Identifier references User on delete Protect,
/// Stores Distance for NvTow.
Distance Decimal(18,4) required,
/// Stores Completed for NvTow.
Completed Decimal(18,4),
/// Stores MaxLoad for NvTow.
MaxLoad Decimal(18,4) required,
/// Stores CurrentLoad for NvTow.
CurrentLoad Decimal(18,4) required,
/// Stores Departure for NvTow.
Departure Date required,
/// Stores StateId for NvTow.
StateId NvTowState Identifier required references NvTowState on delete Protect
);
create unique index UQ_1 on NvTow (Code);
/// Records used by NvTowLeg.
create entity NvTowLeg public (
/// Internal identity.
Id Long Integer identifier auto required,
/// Stores CreatedOn for NvTowLeg.
CreatedOn Date Time required,
/// Stores UpdatedOn for NvTowLeg.
UpdatedOn Date Time,
/// Stores Version for NvTowLeg.
Version Long Integer required default 1,
/// Stores ParentId for NvTowLeg.
ParentId NvTow Identifier required references NvTow on delete Protect,
/// Stores Sequence for NvTowLeg.
Sequence Integer required,
/// Stores Origin for NvTowLeg.
Origin Text(200) required,
/// Stores Destination for NvTowLeg.
Destination Text(200) required,
/// Stores Distance for NvTowLeg.
Distance Decimal(18,4) required
);
create unique index UQ_1 on NvTowLeg (ParentId, Sequence);
/// Records used by NvTowPassenger.
create entity NvTowPassenger public (
/// Internal identity.
Id Long Integer identifier auto required,
/// Stores CreatedOn for NvTowPassenger.
CreatedOn Date Time required,
/// Stores UpdatedOn for NvTowPassenger.
UpdatedOn Date Time,
/// Stores Version for NvTowPassenger.
Version Long Integer required default 1,
/// Stores ParentId for NvTowPassenger.
ParentId NvTow Identifier required references NvTow on delete Protect,
/// Stores Name for NvTowPassenger.
Name Text(200) required,
/// Stores Contact for NvTowPassenger.
Contact Email,
/// Stores Weight for NvTowPassenger.
Weight Decimal(18,4) required
);
/// Records used by NvTowCheckpoint.
create entity NvTowCheckpoint public (
/// Internal identity.
Id Long Integer identifier auto required,
/// Stores CreatedOn for NvTowCheckpoint.
CreatedOn Date Time required,
/// Stores UpdatedOn for NvTowCheckpoint.
UpdatedOn Date Time,
/// Stores Version for NvTowCheckpoint.
Version Long Integer required default 1,
/// Stores ParentId for NvTowCheckpoint.
ParentId NvTow Identifier required references NvTow on delete Protect,
/// Stores ExpectedOn for NvTowCheckpoint.
ExpectedOn Date Time required,
/// Stores ObservedOn for NvTowCheckpoint.
ObservedOn Date Time,
/// Stores Confirmed for NvTowCheckpoint.
Confirmed Boolean
);
/// Records used by NvTowIncident.
create entity NvTowIncident public (
/// Internal identity.
Id Long Integer identifier auto required,
/// Stores CreatedOn for NvTowIncident.
CreatedOn Date Time required,
/// Stores UpdatedOn for NvTowIncident.
UpdatedOn Date Time,
/// Stores Version for NvTowIncident.
Version Long Integer required default 1,
/// Stores ParentId for NvTowIncident.
ParentId NvTow Identifier required references NvTow on delete Protect,
/// Stores Report for NvTowIncident.
Report Text(1600) required,
/// Stores Severity for NvTowIncident.
Severity Integer required,
/// Stores IsClosed for NvTowIncident.
IsClosed Boolean
);
/// Records used by NvTransfer.
create entity NvTransfer public (
/// Internal identity.
Id Long Integer identifier auto required,
/// Stores CreatedOn for NvTransfer.
CreatedOn Date Time required,
/// Stores UpdatedOn for NvTransfer.
UpdatedOn Date Time,
/// Stores Version for NvTransfer.
Version Long Integer required default 1,
/// Stores Code for NvTransfer.
Code Text(50) required,
/// Stores Name for NvTransfer.
Name Text(200) required,
/// Stores CreatedBy for NvTransfer.
CreatedBy User Identifier references User on delete Protect,
/// Stores Distance for NvTransfer.
Distance Decimal(18,4) required,
/// Stores Completed for NvTransfer.
Completed Decimal(18,4),
/// Stores MaxLoad for NvTransfer.
MaxLoad Decimal(18,4) required,
/// Stores CurrentLoad for NvTransfer.
CurrentLoad Decimal(18,4) required,
/// Stores Departure for NvTransfer.
Departure Date required,
/// Stores StateId for NvTransfer.
StateId NvTransferState Identifier required references NvTransferState on delete Protect
);
create unique index UQ_1 on NvTransfer (Code);
/// Records used by NvTransferLeg.
create entity NvTransferLeg public (
/// Internal identity.
Id Long Integer identifier auto required,
/// Stores CreatedOn for NvTransferLeg.
CreatedOn Date Time required,
/// Stores UpdatedOn for NvTransferLeg.
UpdatedOn Date Time,
/// Stores Version for NvTransferLeg.
Version Long Integer required default 1,
/// Stores ParentId for NvTransferLeg.
ParentId NvTransfer Identifier required references NvTransfer on delete Protect,
/// Stores Sequence for NvTransferLeg.
Sequence Integer required,
/// Stores Origin for NvTransferLeg.
Origin Text(200) required,
/// Stores Destination for NvTransferLeg.
Destination Text(200) required,
/// Stores Distance for NvTransferLeg.
Distance Decimal(18,4) required
);
create unique index UQ_1 on NvTransferLeg (ParentId, Sequence);
/// Records used by NvTransferPassenger.
create entity NvTransferPassenger public (
/// Internal identity.
Id Long Integer identifier auto required,
/// Stores CreatedOn for NvTransferPassenger.
CreatedOn Date Time required,
/// Stores UpdatedOn for NvTransferPassenger.
UpdatedOn Date Time,
/// Stores Version for NvTransferPassenger.
Version Long Integer required default 1,
/// Stores ParentId for NvTransferPassenger.
ParentId NvTransfer Identifier required references NvTransfer on delete Protect,
/// Stores Name for NvTransferPassenger.
Name Text(200) required,
/// Stores Contact for NvTransferPassenger.
Contact Email,
/// Stores Weight for NvTransferPassenger.
Weight Decimal(18,4) required
);
/// Records used by NvTransferCheckpoint.
create entity NvTransferCheckpoint public (
/// Internal identity.
Id Long Integer identifier auto required,
/// Stores CreatedOn for NvTransferCheckpoint.
CreatedOn Date Time required,
/// Stores UpdatedOn for NvTransferCheckpoint.
UpdatedOn Date Time,
/// Stores Version for NvTransferCheckpoint.
Version Long Integer required default 1,
/// Stores ParentId for NvTransferCheckpoint.
ParentId NvTransfer Identifier required references NvTransfer on delete Protect,
/// Stores ExpectedOn for NvTransferCheckpoint.
ExpectedOn Date Time required,
/// Stores ObservedOn for NvTransferCheckpoint.
ObservedOn Date Time,
/// Stores Confirmed for NvTransferCheckpoint.
Confirmed Boolean
);
/// Records used by NvTransferIncident.
create entity NvTransferIncident public (
/// Internal identity.
Id Long Integer identifier auto required,
/// Stores CreatedOn for NvTransferIncident.
CreatedOn Date Time required,
/// Stores UpdatedOn for NvTransferIncident.
UpdatedOn Date Time,
/// Stores Version for NvTransferIncident.
Version Long Integer required default 1,
/// Stores ParentId for NvTransferIncident.
ParentId NvTransfer Identifier required references NvTransfer on delete Protect,
/// Stores Report for NvTransferIncident.
Report Text(1600) required,
/// Stores Severity for NvTransferIncident.
Severity Integer required,
/// Stores IsClosed for NvTransferIncident.
IsClosed Boolean
);
