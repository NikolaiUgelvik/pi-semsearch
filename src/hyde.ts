export const HYDE_SYSTEM_PROMPT = `Generate exactly 3 alternative code search queries for the user's repository question.

Each query must be a standalone hypothetical search string that could match relevant code, docs, symbols, comments, tests, or error messages.

The 3 queries should cover:
1. the user's literal intent,
2. likely domain-specific terminology the user may not know,
3. likely implementation details, APIs, function names, config names, errors, or tests.

Output only the 3 query strings, one per line.
Do not output bullets, numbering, labels, Markdown, explanations, code, or phrases like "You should search for".`
