/* Morada: dados fictícios do protótipo (sem servidor, sem armazenamento). */
window.MoradaData = (function () {
  'use strict';

  const cidades = ['São Paulo', 'Campinas', 'Curitiba', 'Florianópolis'];

  const usuarios = [
    { id: 1, nome: 'Ana Ribeiro', perfil: 'inquilino' },
    { id: 2, nome: 'Bruno Teixeira', perfil: 'proprietario' },
    { id: 3, nome: 'Carla Menezes', perfil: 'proprietario' },
    { id: 4, nome: 'Diego Albuquerque', perfil: 'inquilino' }
  ];

  const imoveis = [
    { id: 101, titulo: 'Apartamento com varanda perto do metrô', tipo: 'Apartamento', cidade: 'São Paulo', bairro: 'Vila Mariana', endereco: 'Rua Domingos de Morais, 1200', quartos: 2, banheiros: 2, vagas: 1, area: 68, aluguel: 3200, condominio: 780, iptu: 120, mobiliado: true, pets: true, status: 'ativo', proprietarioId: 2, visualizacoes: 412, fotos: ['assets/casa-2.svg', 'assets/sala.svg', 'assets/cozinha.svg'], descricao: 'Apartamento claro, varanda com vista livre, a 5 minutos a pé da estação Ana Rosa. Armários planejados na cozinha e nos quartos.' },
    { id: 102, titulo: 'Studio mobiliado no centro', tipo: 'Studio', cidade: 'São Paulo', bairro: 'República', endereco: 'Av. Ipiranga, 344', quartos: 1, banheiros: 1, vagas: 0, area: 28, aluguel: 1900, condominio: 450, iptu: 60, mobiliado: true, pets: false, status: 'ativo', proprietarioId: 3, visualizacoes: 655, fotos: ['assets/casa-4.svg', 'assets/sala.svg'], descricao: 'Studio compacto com cama, mesa de trabalho e cozinha equipada. Prédio com portaria 24 horas e lavanderia coletiva.' },
    { id: 103, titulo: 'Casa térrea com quintal', tipo: 'Casa', cidade: 'Campinas', bairro: 'Barão Geraldo', endereco: 'Rua Albino Barbosa de Oliveira, 89', quartos: 3, banheiros: 2, vagas: 2, area: 140, aluguel: 4100, condominio: 0, iptu: 210, mobiliado: false, pets: true, status: 'ativo', proprietarioId: 2, visualizacoes: 238, fotos: ['assets/casa-3.svg', 'assets/cozinha.svg', 'assets/sala.svg'], descricao: 'Casa térrea em rua tranquila, quintal gramado e churrasqueira. Perto da Unicamp e do comércio do bairro.' },
    { id: 104, titulo: 'Kitnet para estudante', tipo: 'Kitnet', cidade: 'Campinas', bairro: 'Cambuí', endereco: 'Rua Coronel Quirino, 1500', quartos: 1, banheiros: 1, vagas: 0, area: 24, aluguel: 1150, condominio: 220, iptu: 35, mobiliado: false, pets: false, status: 'ativo', proprietarioId: 3, visualizacoes: 190, fotos: ['assets/casa-4.svg'], descricao: 'Kitnet reformada, piso vinílico e janela ampla. Contas de água inclusas no condomínio.' },
    { id: 105, titulo: 'Apartamento de 3 quartos no Batel', tipo: 'Apartamento', cidade: 'Curitiba', bairro: 'Batel', endereco: 'Av. do Batel, 1868', quartos: 3, banheiros: 3, vagas: 2, area: 118, aluguel: 5400, condominio: 1350, iptu: 290, mobiliado: false, pets: true, status: 'ativo', proprietarioId: 2, visualizacoes: 301, fotos: ['assets/casa-1.svg', 'assets/sala.svg', 'assets/cozinha.svg'], descricao: 'Planta ampla com suíte master, sacada com churrasqueira e duas vagas cobertas. Condomínio com academia e salão de festas.' },
    { id: 106, titulo: 'Casa de vila reformada', tipo: 'Casa', cidade: 'Curitiba', bairro: 'São Francisco', endereco: 'Rua Mateus Leme, 410', quartos: 2, banheiros: 1, vagas: 1, area: 85, aluguel: 2700, condominio: 90, iptu: 80, mobiliado: false, pets: true, status: 'pausado', proprietarioId: 3, visualizacoes: 97, fotos: ['assets/casa-3.svg', 'assets/sala.svg'], descricao: 'Casa de vila com piso de madeira restaurado, pé-direito alto e pátio interno compartilhado.' },
    { id: 107, titulo: 'Apartamento a duas quadras da praia', tipo: 'Apartamento', cidade: 'Florianópolis', bairro: 'Campeche', endereco: 'Rua Pequeno Príncipe, 2100', quartos: 2, banheiros: 2, vagas: 1, area: 74, aluguel: 3600, condominio: 520, iptu: 140, mobiliado: true, pets: false, status: 'ativo', proprietarioId: 2, visualizacoes: 523, fotos: ['assets/casa-2.svg', 'assets/cozinha.svg'], descricao: 'Mobiliado, com ar-condicionado nos quartos e vaga coberta. Ideal para quem trabalha remoto perto do mar.' },
    { id: 108, titulo: 'Studio novo perto da UFSC', tipo: 'Studio', cidade: 'Florianópolis', bairro: 'Trindade', endereco: 'Rua Lauro Linhares, 970', quartos: 1, banheiros: 1, vagas: 0, area: 31, aluguel: 2100, condominio: 380, iptu: 50, mobiliado: true, pets: true, status: 'ativo', proprietarioId: 3, visualizacoes: 276, fotos: ['assets/casa-4.svg', 'assets/sala.svg'], descricao: 'Studio em prédio novo, com bicicletário e área de coworking no térreo.' }
  ];

  const propostas = [
    { id: 501, imovelId: 101, inquilinoId: 1, valor: 3000, inicio: '2026-11-01', prazo: 30, status: 'pendente', enviadaEm: '2026-10-08', mensagem: 'Posso assinar já no início do mês.' },
    { id: 502, imovelId: 107, inquilinoId: 1, valor: 3600, inicio: '2026-12-01', prazo: 12, status: 'aceita', enviadaEm: '2026-10-02', mensagem: '' },
    { id: 503, imovelId: 103, inquilinoId: 4, valor: 3900, inicio: '2026-11-15', prazo: 24, status: 'pendente', enviadaEm: '2026-10-09', mensagem: 'Tenho dois cachorros de porte pequeno.' },
    { id: 504, imovelId: 105, inquilinoId: 4, valor: 5000, inicio: '2026-11-01', prazo: 30, status: 'recusada', enviadaEm: '2026-09-28', mensagem: '' },
    { id: 505, imovelId: 102, inquilinoId: 1, valor: 1800, inicio: '2026-11-01', prazo: 12, status: 'cancelada', enviadaEm: '2026-09-20', mensagem: '' }
  ];

  const visitas = [];

  return {
    cidades,
    usuarios,
    imoveis,
    propostas,
    visitas,
    favoritos: new Set([103, 107]),
    usuarioAtualId: null,
    proximoId: { imovel: 109, proposta: 506, visita: 1 }
  };
})();
