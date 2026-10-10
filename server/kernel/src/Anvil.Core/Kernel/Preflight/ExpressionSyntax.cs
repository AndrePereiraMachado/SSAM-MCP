namespace Anvil.Core.Preflight;

/// <summary>
/// primeira-certa A4: the syntax of an OutSystems expression, judged on the tokens of <see cref="ExpressionText"/> (the
/// lexer the base phase and every expression rule already read), before any model: what the Studio's parser refuses as
/// ParserUnexpectedElement, ParserExpectedElement or ParserUnterminatedStringLiteral. Only what no expression of the
/// language can be: unbalanced quotes, an unterminated date, unbalanced or crossed brackets, a character the language does
/// not have (&amp;&amp;, ||, !=, ==, ', ;), two operands without an operator, an operator without an operand, an empty
/// argument or group, a comma outside a call. A name, a type or a function the lexer does not know is never judged here.
/// </summary>
public static class ExpressionSyntax
{
    private static readonly System.Text.RegularExpressions.Regex Literals = new("\"(?:[^\"]|\"\")*\"", System.Text.RegularExpressions.RegexOptions.Compiled);

    /// <summary>What is wrong with <paramref name="text"/> as an expression, with the fix; null when its syntax holds.</summary>
    public static (string Problem, string Fix)? Check(string text)
    {
        if (string.IsNullOrWhiteSpace(text)) return null;
        if (Literals.Replace(text, "").Contains('"'))
            return ("the quotes of the expression are unbalanced", "close every text literal with \" (a quote inside a text is written \"\")");
        var tokens = ExpressionText.Tokens(text);
        var stack = new Stack<(TokenKind Kind, bool Call)>();
        Token? previous = null;
        foreach (var t in tokens)
        {
            switch (t.Kind)
            {
                case TokenKind.Date when t.Text.Length < 2 || !t.Text.EndsWith('#'):
                    return ($"the date literal {t.Text} is not closed", "write a date as #2026-10-10# (a date time as #2026-10-10 12:00:00#)");
                case TokenKind.Other when t.Text != "." || previous == null || previous.Kind is not (TokenKind.Close or TokenKind.CloseIndex):
                    return (Unexpected(t.Text), FixOf(t.Text));
                case TokenKind.Other:
                    break;   // the member access after a call or an index: F(x).Name
                case TokenKind.Open:
                    // A call: a name right before the parenthesis; any other operand before it is two operands in a row.
                    if (previous != null && previous.Kind is TokenKind.Number or TokenKind.Text or TokenKind.Date or TokenKind.Close or TokenKind.CloseIndex)
                        return ($"'(' right after {previous.Text}: an operand is followed by another without an operator", "put an operator (+, -, *, /, =, <>, <, >, and, or) between them");
                    stack.Push((TokenKind.Open, previous is { Kind: TokenKind.Name }));
                    break;
                case TokenKind.OpenIndex:
                    if (previous == null || previous.Kind is not (TokenKind.Name or TokenKind.Close or TokenKind.CloseIndex))
                        return ("'[' without a list before it", "index a list as List[i]");
                    stack.Push((TokenKind.OpenIndex, false));
                    break;
                case TokenKind.Close or TokenKind.CloseIndex:
                {
                    var wanted = t.Kind == TokenKind.Close ? TokenKind.Open : TokenKind.OpenIndex;
                    if (stack.Count == 0 || stack.Peek().Kind != wanted)
                        return ($"'{t.Text}' without its opening {(wanted == TokenKind.Open ? "'('" : "'['")}", "balance the parentheses and brackets of the expression");
                    var (_, call) = stack.Pop();
                    if (previous is { Kind: TokenKind.Comma }) return ($"an empty argument before '{t.Text}'", "remove the comma, or write the argument");
                    if (previous is { Kind: TokenKind.Operator }) return ($"the operator '{previous.Text}' has no operand after it", "write the operand after the operator, or remove the operator");
                    if (previous is { Kind: TokenKind.OpenIndex }) return ("an empty index []", "write the index: List[i]");
                    if (previous is { Kind: TokenKind.Open } && !call) return ("empty parentheses ()", "write the expression inside the parentheses, or remove them");
                    break;
                }
                case TokenKind.Comma:
                    if (stack.Count == 0 || stack.Peek() is not (TokenKind.Open, true))
                        return ("a comma outside the arguments of a function", "separate values only inside the parentheses of a function call");
                    if (previous is null or { Kind: TokenKind.Comma or TokenKind.Open })
                        return ("an empty argument", "remove the comma, or write the argument");
                    if (previous is { Kind: TokenKind.Operator }) return ($"the operator '{previous.Text}' has no operand after it", "write the operand after the operator, or remove the operator");
                    break;
                case TokenKind.Operator:
                    if (!Unary(t) && (previous == null || previous.Kind is TokenKind.Operator or TokenKind.Open or TokenKind.OpenIndex or TokenKind.Comma))
                        return (previous is { Kind: TokenKind.Operator } && t.Text == "=" && previous.Text == "="
                            ? ("'==' is not an operator of OutSystems expressions", "compare with a single =")
                            : ($"the operator '{t.Text}' has no operand before it", "write the operand before the operator, or remove the operator"));
                    break;
                default:
                    // An operand (name, number, text, date): never right after another operand.
                    if (previous != null && previous.Kind is TokenKind.Name or TokenKind.Number or TokenKind.Text or TokenKind.Date or TokenKind.Close or TokenKind.CloseIndex
                        && !(t.Kind == TokenKind.Name && t.Text.StartsWith('.')))
                        return ($"{t.Text} right after {previous.Text}: two operands without an operator", "put an operator (+, -, *, /, =, <>, <, >, and, or) between them, or quote the text");
                    break;
            }
            previous = t;
        }
        if (stack.Count > 0) return ($"'{(stack.Peek().Kind == TokenKind.Open ? "(" : "[")}' is not closed", "balance the parentheses and brackets of the expression");
        if (previous is { Kind: TokenKind.Operator }) return ($"the operator '{previous.Text}' has no operand after it", "write the operand after the operator, or remove the operator");
        return null;
    }

    /// <summary>An operator that may start an operand: unary minus and plus, and `not`.</summary>
    private static bool Unary(Token t) => t.Text is "-" or "+" || t.Is("not");

    private static string Unexpected(string c) => c switch
    {
        "&" => "'&' is not an operator of OutSystems expressions",
        "|" => "'|' is not an operator of OutSystems expressions",
        "!" => "'!' is not an operator of OutSystems expressions",
        "'" => "a text between single quotes",
        _ => $"the character '{c}' is not part of the expression language",
    };

    private static string FixOf(string c) => c switch
    {
        "&" => "write and (&& is and; & is not a concatenation: use +)",
        "|" => "write or",
        "!" => "write not, and <> for different",
        "'" => "write texts between double quotes: \"text\"",
        _ => "remove it, or quote the text",
    };
}
