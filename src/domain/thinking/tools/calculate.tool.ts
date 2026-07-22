/**
 * Safe mathematical expression evaluation
 *
 * Only allows numbers and basic operators, preventing code injection
 */
export function calculate(expression: string): number {
  try {
    // Safety check: only allow numbers, operators, parentheses, and spaces
    if (!/^[\d+\-*/().\s]+$/.test(expression)) {
      throw new Error(
        'Invalid expression: only numbers and basic operators allowed',
      );
    }

    // Deliberate: the regex above constrains input to digits/operators/parens,
    // so this is a contained arithmetic evaluator (no identifiers can reach it).
    // biome-ignore lint/security/noGlobalEval: intentional sandboxed arithmetic evaluator, input regex-constrained above
    const result = eval(expression);
    if (typeof result !== 'number' || !isFinite(result)) {
      throw new Error('Invalid calculation result');
    }
    // Precision control: round to 4 decimal places
    return Math.round(result * 10000) / 10000;
  } catch (error) {
    throw new Error(
      `Calculation error: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
}
