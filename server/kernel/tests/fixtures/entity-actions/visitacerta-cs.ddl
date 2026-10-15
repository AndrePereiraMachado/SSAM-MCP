/// Ciclo de vida de uma visita, do agendamento ao encerramento; guia filtros da agenda e o histórico.
create static entity StatusVisita public (
  Id Integer identifier required,
  Label Text(50) required,
  Order Integer required,
  IsFinal Boolean required default False
)
values
  Agendada (Id = 1, Label = "Agendada", Order = 1, IsFinal = False),
  EmDeslocamento (Id = 2, Label = "Em deslocamento", Order = 2, IsFinal = False),
  EmAndamento (Id = 3, Label = "Em andamento", Order = 3, IsFinal = False),
  Concluida (Id = 4, Label = "Concluída", Order = 4, IsFinal = True),
  Reagendada (Id = 5, Label = "Reagendada", Order = 5, IsFinal = False),
  Cancelada (Id = 6, Label = "Cancelada", Order = 6, IsFinal = True);

/// Urgência combinada com o cliente; ordena a agenda do técnico quando há conflito de horário.
create static entity PrioridadeVisita public (
  Id Integer identifier required,
  Label Text(50) required,
  Order Integer required,
  PrazoHoras Integer required
)
values
  Baixa (Id = 1, Label = "Baixa", Order = 4, PrazoHoras = 168),
  Media (Id = 2, Label = "Média", Order = 3, PrazoHoras = 72),
  Alta (Id = 3, Label = "Alta", Order = 2, PrazoHoras = 24),
  Urgente (Id = 4, Label = "Urgente", Order = 1, PrazoHoras = 4);

/// Natureza do serviço; define o checklist padrão e a duração estimada da visita.
create static entity TipoVisita public (
  Id Integer identifier required,
  Label Text(50) required,
  Order Integer required,
  DuracaoPadraoMin Integer required
)
values
  Instalacao (Id = 1, Label = "Instalação", Order = 1, DuracaoPadraoMin = 180),
  Manutencao (Id = 2, Label = "Manutenção corretiva", Order = 2, DuracaoPadraoMin = 120),
  Preventiva (Id = 3, Label = "Manutenção preventiva", Order = 3, DuracaoPadraoMin = 90),
  Inspecao (Id = 4, Label = "Inspeção", Order = 4, DuracaoPadraoMin = 60),
  Treinamento (Id = 5, Label = "Treinamento", Order = 5, DuracaoPadraoMin = 240);

/// Natureza do gasto, usada para aplicar limites diários e agrupar o relatório de reembolso.
create static entity CategoriaDespesa public (
  Id Integer identifier required,
  Label Text(50) required,
  Order Integer required,
  ExigeComprovante Boolean required default True
)
values
  Combustivel (Id = 1, Label = "Combustível", Order = 1, ExigeComprovante = True),
  Pedagio (Id = 2, Label = "Pedágio", Order = 2, ExigeComprovante = True),
  Estacionamento (Id = 3, Label = "Estacionamento", Order = 3, ExigeComprovante = True),
  Alimentacao (Id = 4, Label = "Alimentação", Order = 4, ExigeComprovante = True),
  Hospedagem (Id = 5, Label = "Hospedagem", Order = 5, ExigeComprovante = True),
  Material (Id = 6, Label = "Material de reposição", Order = 6, ExigeComprovante = True),
  Quilometragem (Id = 7, Label = "Quilometragem (veículo próprio)", Order = 7, ExigeComprovante = False),
  Outros (Id = 8, Label = "Outros", Order = 8, ExigeComprovante = True);

/// Etapas da aprovação de uma despesa até o reembolso ao técnico.
create static entity StatusDespesa public (
  Id Integer identifier required,
  Label Text(50) required,
  Order Integer required
)
values
  Rascunho (Id = 1, Label = "Rascunho", Order = 1),
  Enviada (Id = 2, Label = "Enviada", Order = 2),
  Aprovada (Id = 3, Label = "Aprovada", Order = 3),
  Rejeitada (Id = 4, Label = "Rejeitada", Order = 4),
  Reembolsada (Id = 5, Label = "Reembolsada", Order = 5);

/// Condição do tempo normalizada a partir da API de clima; sinaliza visitas externas em risco.
create static entity CondicaoClima public (
  Id Integer identifier required,
  Label Text(50) required,
  Order Integer required,
  IsRiscoVisitaExterna Boolean required default False
)
values
  Ensolarado (Id = 1, Label = "Ensolarado", Order = 1, IsRiscoVisitaExterna = False),
  ParcialmenteNublado (Id = 2, Label = "Parcialmente nublado", Order = 2, IsRiscoVisitaExterna = False),
  Nublado (Id = 3, Label = "Nublado", Order = 3, IsRiscoVisitaExterna = False),
  Neblina (Id = 4, Label = "Neblina", Order = 4, IsRiscoVisitaExterna = True),
  Chuva (Id = 5, Label = "Chuva", Order = 5, IsRiscoVisitaExterna = True),
  Tempestade (Id = 6, Label = "Tempestade", Order = 6, IsRiscoVisitaExterna = True);

/// Abrangência do feriado; decide se ele bloqueia a agenda no país, no estado ou só na cidade.
create static entity TipoFeriado public (
  Id Integer identifier required,
  Label Text(50) required,
  Order Integer required
)
values
  Nacional (Id = 1, Label = "Nacional", Order = 1),
  Estadual (Id = 2, Label = "Estadual", Order = 2),
  Municipal (Id = 3, Label = "Municipal", Order = 3),
  PontoFacultativo (Id = 4, Label = "Ponto facultativo", Order = 4);

/// Como o técnico pagou a despesa; define se há reembolso ou só conciliação do cartão.
create static entity FormaPagamento public (
  Id Integer identifier required,
  Label Text(50) required,
  Order Integer required,
  IsReembolsavel Boolean required default True
)
values
  CartaoCorporativo (Id = 1, Label = "Cartão corporativo", Order = 1, IsReembolsavel = False),
  Dinheiro (Id = 2, Label = "Dinheiro", Order = 2, IsReembolsavel = True),
  Pix (Id = 3, Label = "Pix", Order = 3, IsReembolsavel = True),
  Adiantamento (Id = 4, Label = "Adiantamento de viagem", Order = 4, IsReembolsavel = False);

/// Senioridade do técnico; define os limites de despesa e quais tipos de visita ele pode assumir.
create static entity NivelTecnico public (
  Id Integer identifier required,
  Label Text(50) required,
  Order Integer required
)
values
  Junior (Id = 1, Label = "Júnior", Order = 1),
  Pleno (Id = 2, Label = "Pleno", Order = 2),
  Senior (Id = 3, Label = "Sênior", Order = 3),
  Especialista (Id = 4, Label = "Especialista", Order = 4);

/// Resultado de cada item do checklist executado na visita.
create static entity StatusItemChecklist public (
  Id Integer identifier required,
  Label Text(50) required,
  Order Integer required
)
values
  Pendente (Id = 1, Label = "Pendente", Order = 1),
  Conforme (Id = 2, Label = "Conforme", Order = 2),
  NaoConforme (Id = 3, Label = "Não conforme", Order = 3),
  NaoAplicavel (Id = 4, Label = "Não se aplica", Order = 4);

/// Unidades federativas; usadas para feriados estaduais e para localizar cidades.
create static entity Estado public (
  Id Integer identifier required,
  Label Text(50) required,
  Sigla Text(2) required,
  Order Integer required
)
values
  AC (Id = 12, Label = "Acre", Sigla = "AC", Order = 1),
  AL (Id = 27, Label = "Alagoas", Sigla = "AL", Order = 2),
  AP (Id = 16, Label = "Amapá", Sigla = "AP", Order = 3),
  AM (Id = 13, Label = "Amazonas", Sigla = "AM", Order = 4),
  BA (Id = 29, Label = "Bahia", Sigla = "BA", Order = 5),
  CE (Id = 23, Label = "Ceará", Sigla = "CE", Order = 6),
  DF (Id = 53, Label = "Distrito Federal", Sigla = "DF", Order = 7),
  ES (Id = 32, Label = "Espírito Santo", Sigla = "ES", Order = 8),
  GO (Id = 52, Label = "Goiás", Sigla = "GO", Order = 9),
  MA (Id = 21, Label = "Maranhão", Sigla = "MA", Order = 10),
  MT (Id = 51, Label = "Mato Grosso", Sigla = "MT", Order = 11),
  MS (Id = 50, Label = "Mato Grosso do Sul", Sigla = "MS", Order = 12),
  MG (Id = 31, Label = "Minas Gerais", Sigla = "MG", Order = 13),
  PA (Id = 15, Label = "Pará", Sigla = "PA", Order = 14),
  PB (Id = 25, Label = "Paraíba", Sigla = "PB", Order = 15),
  PR (Id = 41, Label = "Paraná", Sigla = "PR", Order = 16),
  PE (Id = 26, Label = "Pernambuco", Sigla = "PE", Order = 17),
  PI (Id = 22, Label = "Piauí", Sigla = "PI", Order = 18),
  RJ (Id = 33, Label = "Rio de Janeiro", Sigla = "RJ", Order = 19),
  RN (Id = 24, Label = "Rio Grande do Norte", Sigla = "RN", Order = 20),
  RS (Id = 43, Label = "Rio Grande do Sul", Sigla = "RS", Order = 21),
  RO (Id = 11, Label = "Rondônia", Sigla = "RO", Order = 22),
  RR (Id = 14, Label = "Roraima", Sigla = "RR", Order = 23),
  SC (Id = 42, Label = "Santa Catarina", Sigla = "SC", Order = 24),
  SP (Id = 35, Label = "São Paulo", Sigla = "SP", Order = 25),
  SE (Id = 28, Label = "Sergipe", Sigla = "SE", Order = 26),
  TO (Id = 17, Label = "Tocantins", Sigla = "TO", Order = 27);

/// Área de atendimento de uma equipe; agrupa técnicos para distribuir as visitas.
create entity Regiao public label Nome (
  Id Long Integer identifier auto required,
  Nome Text(80) required,
  Descricao Text(500),
  IsAtiva Boolean required default True
);
create unique index UQ_Regiao_Nome on Regiao (Nome);

/// Município com coordenadas; chave para a previsão do tempo e para feriados municipais.
create entity Cidade public label Nome (
  Id Long Integer identifier auto required,
  Nome Text(120) required,
  EstadoId Estado Identifier required references Estado on delete Protect,
  CodigoIbge Text(7) required,
  Latitude Decimal(9,6),
  Longitude Decimal(9,6)
);
create unique index UQ_Cidade_CodigoIbge on Cidade (CodigoIbge);
create index IX_Cidade_Estado_Nome on Cidade (EstadoId, Nome);

/// Empresa atendida pelos técnicos de campo.
create entity Cliente public label Nome (
  Id Long Integer identifier auto required,
  Nome Text(150) required,
  Documento Text(18) required,
  Email Email,
  Telefone Phone Number,
  Observacoes Text(1000),
  IsAtivo Boolean required default True,
  CriadoEm Date Time required default CurrDateTime()
);
create unique index UQ_Cliente_Documento on Cliente (Documento);

/// Local físico onde a visita acontece; um cliente pode ter várias unidades.
create entity EnderecoCliente public label Descricao (
  Id Long Integer identifier auto required,
  ClienteId Cliente Identifier required references Cliente on delete Delete,
  CidadeId Cidade Identifier required references Cidade on delete Protect,
  Descricao Text(80) required,
  Logradouro Text(200) required,
  Numero Text(20),
  Complemento Text(100),
  Bairro Text(100),
  Cep Text(9),
  Latitude Decimal(9,6),
  Longitude Decimal(9,6),
  IsPrincipal Boolean required default False
);
create index IX_EndCliente_Principal on EnderecoCliente (ClienteId, IsPrincipal);

/// Pessoa do cliente que recebe o técnico e confirma o atendimento.
create entity ContatoCliente public label Nome (
  Id Long Integer identifier auto required,
  ClienteId Cliente Identifier required references Cliente on delete Delete,
  Nome Text(120) required,
  Cargo Text(80),
  Email Email,
  Telefone Phone Number,
  IsPrincipal Boolean required default False
);
create index IX_ContCliente_Principal on ContatoCliente (ClienteId, IsPrincipal);

/// Profissional de campo que executa as visitas e registra despesas.
create entity Tecnico public label Nome (
  Id Long Integer identifier auto required,
  Nome Text(120) required,
  Email Email required,
  Telefone Phone Number,
  NivelTecnicoId NivelTecnico Identifier required references NivelTecnico on delete Protect,
  RegiaoId Regiao Identifier required references Regiao on delete Protect,
  CidadeBaseId Cidade Identifier required references Cidade on delete Protect,
  IsAtivo Boolean required default True
);
create unique index UQ_Tecnico_Email on Tecnico (Email);
create index IX_Tecnico_Regiao_Ativo on Tecnico (RegiaoId, IsAtivo);

/// Competência técnica (ex.: refrigeração, redes); casa o técnico certo com a visita.
create entity Especialidade public label Nome (
  Id Long Integer identifier auto required,
  Nome Text(80) required,
  Descricao Text(500)
);
create unique index UQ_Especialidade_Nome on Especialidade (Nome);

/// Liga técnicos às especialidades que dominam (relação muitos-para-muitos).
create entity TecnicoEspecialidade public (
  Id Long Integer identifier auto required,
  TecnicoId Tecnico Identifier required references Tecnico on delete Delete,
  EspecialidadeId Especialidade Identifier required references Especialidade on delete Delete,
  CertificadoAte Date
);
create unique index UQ_TecnicoEspecialidade on TecnicoEspecialidade (TecnicoId, EspecialidadeId);

/// Atendimento planejado a um cliente; centro do planejamento com clima, feriados e despesas.
create entity Visita public label Titulo (
  Id Long Integer identifier auto required,
  ClienteId Cliente Identifier required references Cliente on delete Protect,
  EnderecoClienteId EnderecoCliente Identifier required references EnderecoCliente on delete Protect,
  ContatoClienteId ContatoCliente Identifier references ContatoCliente on delete Ignore,
  TecnicoId Tecnico Identifier required references Tecnico on delete Protect,
  TipoVisitaId TipoVisita Identifier required references TipoVisita on delete Protect,
  StatusVisitaId StatusVisita Identifier required references StatusVisita on delete Protect,
  PrioridadeVisitaId PrioridadeVisita Identifier required references PrioridadeVisita on delete Protect,
  EspecialidadeId Especialidade Identifier references Especialidade on delete Ignore,
  Titulo Text(150) required,
  Descricao Text(2000),
  DataPrevista Date required,
  HoraPrevista Time,
  DuracaoPrevistaMin Integer required default 60,
  InicioReal Date Time,
  FimReal Date Time,
  Observacoes Text(2000),
  CriadaEm Date Time required default CurrDateTime()
);
create index IX_Visita_Tecnico_Data on Visita (TecnicoId, DataPrevista);
create index IX_Visita_Cliente_Data on Visita (ClienteId, DataPrevista);
create index IX_Visita_Status_Data on Visita (StatusVisitaId, DataPrevista);

/// Item padrão de checklist por tipo de visita; copiado para cada visita ao agendar.
create entity ChecklistItemModelo public label Descricao (
  Id Long Integer identifier auto required,
  TipoVisitaId TipoVisita Identifier required references TipoVisita on delete Protect,
  Descricao Text(200) required,
  Ordem Integer required,
  IsObrigatorio Boolean required default True,
  IsAtivo Boolean required default True
);
create index IX_ChkModelo_Tipo_Ordem on ChecklistItemModelo (TipoVisitaId, Ordem);

/// Resultado de um item do checklist numa visita específica.
create entity VisitaChecklist public (
  Id Long Integer identifier auto required,
  VisitaId Visita Identifier required references Visita on delete Delete,
  ChecklistItemModeloId ChecklistItemModelo Identifier required references ChecklistItemModelo on delete Protect,
  StatusItemChecklistId StatusItemChecklist Identifier required references StatusItemChecklist on delete Protect,
  Observacao Text(500),
  RespondidoEm Date Time
);
create unique index UQ_VisitaChecklist_Item on VisitaChecklist (VisitaId, ChecklistItemModeloId);

/// Trilha de auditoria das mudanças de status de cada visita.
create entity HistoricoStatusVisita public (
  Id Long Integer identifier auto required,
  VisitaId Visita Identifier required references Visita on delete Delete,
  StatusVisitaId StatusVisita Identifier required references StatusVisita on delete Protect,
  AlteradoEm Date Time required default CurrDateTime(),
  Comentario Text(500)
);
create index IX_HistStatus_Visita_Data on HistoricoStatusVisita (VisitaId, AlteradoEm);

/// Previsão diária por cidade guardada da API de clima; evita consultar a API a cada tela.
create entity PrevisaoClima public (
  Id Long Integer identifier auto required,
  CidadeId Cidade Identifier required references Cidade on delete Delete,
  Data Date required,
  CondicaoClimaId CondicaoClima Identifier required references CondicaoClima on delete Protect,
  TemperaturaMin Decimal(5,1),
  TemperaturaMax Decimal(5,1),
  ProbabilidadeChuva Integer,
  VentoKmh Decimal(5,1),
  ConsultadoEm Date Time required default CurrDateTime()
);
create unique index UQ_PrevisaoClima_Cidade_Data on PrevisaoClima (CidadeId, Data);

/// Feriado que impede ou desaconselha visitas; vem da API de feriados ou de cadastro manual.
create entity Feriado public label Nome (
  Id Long Integer identifier auto required,
  Data Date required,
  Nome Text(120) required,
  TipoFeriadoId TipoFeriado Identifier required references TipoFeriado on delete Protect,
  EstadoId Estado Identifier references Estado on delete Ignore,
  CidadeId Cidade Identifier references Cidade on delete Delete,
  IsImportado Boolean required default False
);
create index IX_Feriado_Data_Tipo on Feriado (Data, TipoFeriadoId);

/// Gasto do técnico ligado a uma visita, sujeito a aprovação e reembolso.
create entity Despesa public label Descricao (
  Id Long Integer identifier auto required,
  VisitaId Visita Identifier required references Visita on delete Protect,
  TecnicoId Tecnico Identifier required references Tecnico on delete Protect,
  CategoriaDespesaId CategoriaDespesa Identifier required references CategoriaDespesa on delete Protect,
  FormaPagamentoId FormaPagamento Identifier required references FormaPagamento on delete Protect,
  StatusDespesaId StatusDespesa Identifier required references StatusDespesa on delete Protect,
  Data Date required,
  Valor Currency required,
  Descricao Text(300) required,
  KmRodados Decimal(8,1),
  MotivoRejeicao Text(500),
  CriadaEm Date Time required default CurrDateTime()
);
create index IX_Despesa_Visita_Status on Despesa (VisitaId, StatusDespesaId);
create index IX_Despesa_Tecnico_Data on Despesa (TecnicoId, Data);

/// Arquivo (foto ou PDF) que comprova uma despesa.
create entity ComprovanteDespesa public label NomeArquivo (
  Id Long Integer identifier auto required,
  DespesaId Despesa Identifier required references Despesa on delete Delete,
  NomeArquivo Text(200) required,
  TipoMime Text(100) required,
  Conteudo Binary Data required,
  EnviadoEm Date Time required default CurrDateTime()
);
create index IX_Comprovante_Despesa on ComprovanteDespesa (DespesaId, EnviadoEm);

/// Teto diário por categoria e nível do técnico; despesas acima dele exigem justificativa.
create entity LimiteDespesa public (
  Id Long Integer identifier auto required,
  CategoriaDespesaId CategoriaDespesa Identifier required references CategoriaDespesa on delete Protect,
  NivelTecnicoId NivelTecnico Identifier required references NivelTecnico on delete Protect,
  ValorDiario Currency required,
  VigenteDesde Date required
);
create unique index UQ_Limite_Cat_Nivel_Vig on LimiteDespesa (CategoriaDespesaId, NivelTecnicoId, VigenteDesde);
