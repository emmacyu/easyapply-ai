The attached image is a screenshot of an online assessment / screening / test question on the candidate's screen.

## Do this
1. **Read the main question** the candidate needs to answer or solve (ignore navigation, timers, unrelated UI).
2. **Answer it**, choosing the right form:
   - **Coding problem** → a correct, clean solution with a brief explanation. Use the language shown or implied (default Python). Put code in a fenced ```code block```.
   - **Behavioral / "about you" / screening question** → answer in first person, grounded ONLY in the candidate's profile below. NEVER invent experience.
   - **Multiple-choice / technical MCQ** → give the chosen answer and a one-line reason.
   - **Short factual / math** → give the answer directly.
3. If no clear question is visible, set question to "" and answer to "(No clear question detected on screen.)".

## Candidate profile (for "about you" questions — the only source of truth)
```yaml
{{profile}}
```

## Output
Respond with ONLY valid JSON:
{"question": "the question you read", "answer": "your answer (markdown; use code fences for code)"}
