# LoginForm

OutSystemsUIWeb 1.12.8 | Traditional | UI flow **Layouts** | publico | 32 widgets internos

Component used in the Login Layout.

When you have your own custom Login Page, this component can be used to accelarate the login page construction.

Already has CSS and Animated Labels and all the basic pieces for a login.

## Inputs

Nenhum.

## Placeholders

- **Login**: Drag your login related content to this placeholder. | nasce com: Container, Container, Container, Container (use `"empty": true` no create para comecar vazio; nomes reais sao renumerados, enderece por tipo `#Tipo[n]`)

## Eventos

Nenhum.

## Composicao interna

- Usa os blocos: AnimatedLabel, AlignCenter
- Actions do bloco: Forgotpassword, LogIn
- Chama actions do modulo: Feedback_Message (contratos em [actions.md](../actions.md))

## JavaScript

Sem JavaScript proprio.
## CSS

Sem CSS proprio (estilo vem do tema).

## Como criar (verbos)

```json
{"op":"create","parent":"<placeholder ou container da tela>","type":"IWebBlockInstanceWidget","name":"LoginForm1","source":"IWebBlock:LoginForm","empty":true,"as":"$b"}
```
