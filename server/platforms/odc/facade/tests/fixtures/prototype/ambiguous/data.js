// Data with no seed-like name: the capture cannot pick the store by itself.
window.Store = {
  initial: function () {
    return {
      Obra: [
        { Id: 1, Nome: 'Ponte Norte', Etapa: 'Fundacao' },
        { Id: 2, Nome: 'Viaduto Sul', Etapa: 'Estrutura' },
        { Id: 3, Nome: 'Tunel Leste', Etapa: 'Projeto' }
      ]
    };
  }
};
window.DATA = [{ Id: 1, Nome: 'Ponte Norte', Etapa: 'Fundacao' }, { Id: 2, Nome: 'Viaduto Sul', Etapa: 'Estrutura' }];
