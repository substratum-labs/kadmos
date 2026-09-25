/** A deliberately small expression language for World guards and invariants. */
export function identifiers(expression: string): string[] {
  const tokens = tokenize(expression);
  return tokens.filter((token, index) => /^[A-Za-z_]/.test(token) && tokens[index - 1] !== "." && !["true", "false", "null"].includes(token));
}

function tokenize(expression: string): string[] {
  const tokens: string[] = [];
  const pattern = /\s+|=>|==|!=|>=|<=|&&|\|\||[()+\-*/<>!.]|\d+(?:\.\d+)?|[A-Za-z_][A-Za-z_0-9]*|'(?:[^'\\]|\\.)*'/gy;
  let offset = 0;
  while (offset < expression.length) {
    pattern.lastIndex = offset;
    const match = pattern.exec(expression);
    if (!match) throw new Error(`INVALID_EXPRESSION: ${expression.slice(offset)}`);
    offset = pattern.lastIndex;
    if (!/^\s+$/.test(match[0])) tokens.push(match[0]);
  }
  return tokens;
}

type Environment = Readonly<Record<string, unknown>>;
const precedence: Readonly<Record<string, number>> = {
  "=>": 1, "||": 2, "&&": 3, "==": 4, "!=": 4,
  ">": 5, ">=": 5, "<": 5, "<=": 5,
  "+": 6, "-": 6, "*": 7, "/": 7,
};

export function evaluate(expression: string | boolean, environment: Environment): unknown {
  if (typeof expression === "boolean") return expression;
  const tokens = tokenize(expression);
  let position = 0;
  const take = () => tokens[position++];
  const parse = (minimum = 0): unknown => {
    const first = take();
    if (first === undefined) throw new Error("INVALID_EXPRESSION: missing operand");
    let left: unknown;
    if (first === "(") {
      left = parse();
      if (take() !== ")") throw new Error("INVALID_EXPRESSION: missing )");
    } else if (first === "!" || first === "-") {
      const operand = parse(8);
      left = first === "!" ? !boolean(operand) : -number(operand);
    } else if (first === "true" || first === "false") {
      left = first === "true";
    } else if (first === "null") {
      left = null;
    } else if (first.startsWith("'")) {
      left = first.slice(1, -1).replace(/\\'/g, "'");
    } else if (/^\d/.test(first)) {
      left = Number(first);
    } else if (/^[A-Za-z_]/.test(first)) {
      left = environment[first];
      while (tokens[position] === ".") {
        take();
        const property = take();
        if (!property || !/^[A-Za-z_][A-Za-z_0-9]*$/.test(property)) throw new Error("INVALID_EXPRESSION: property");
        left = left && typeof left === "object" ? (left as Record<string, unknown>)[property] : undefined;
      }
    } else {
      throw new Error(`INVALID_EXPRESSION: ${first}`);
    }
    while (true) {
      const operator = tokens[position];
      const priority = operator === undefined ? undefined : precedence[operator];
      if (priority === undefined || priority < minimum) break;
      take();
      const right = parse(priority + (operator === "=>" ? 0 : 1));
      switch (operator) {
        case "=>": left = !boolean(left) || boolean(right); break;
        case "||": left = boolean(left) || boolean(right); break;
        case "&&": left = boolean(left) && boolean(right); break;
        case "==": left = left === right; break;
        case "!=": left = left !== right; break;
        case ">": left = number(left) > number(right); break;
        case ">=": left = number(left) >= number(right); break;
        case "<": left = number(left) < number(right); break;
        case "<=": left = number(left) <= number(right); break;
        case "+": left = number(left) + number(right); break;
        case "-": left = number(left) - number(right); break;
        case "*": left = number(left) * number(right); break;
        case "/": left = number(left) / number(right); break;
      }
    }
    return left;
  };
  const value = parse();
  if (position !== tokens.length) throw new Error(`INVALID_EXPRESSION: ${tokens[position]}`);
  return value;
}

function number(value: unknown): number {
  if (typeof value !== "number" || !Number.isFinite(value)) throw new Error("INVALID_EXPRESSION: expected number");
  return value;
}

function boolean(value: unknown): boolean {
  if (typeof value !== "boolean") throw new Error("INVALID_EXPRESSION: expected boolean operand");
  return value;
}
