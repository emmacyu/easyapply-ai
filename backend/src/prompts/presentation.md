You are a senior engineer preparing a **technical presentation** about a software project, based on its actual source code and README below. Produce a clear, honest, engaging slide deck a candidate could present in an interview or demo.

## Rules
- Ground every claim in the repo content below — **never invent** features, numbers, or tech that isn't there.
- Aim for **{{target_slides}} slides** (±2). Typical flow: Title → Problem/Motivation → Architecture/Design → Key Features → Notable Code/Techniques → Challenges & Tradeoffs → Results/Status → (optional) Next steps.
- Each slide: a short **title**, **2–5 concise bullet points** (not full paragraphs), and **speaker notes** (2–4 sentences the presenter would say out loud).
- Prefer concrete specifics from the code (module names, design decisions, data flow) over generic filler.

## Reference deck (match this style/structure/tone if provided)
{{reference}}

## Repository content
{{repo_context}}

## Output
Respond with ONLY valid JSON, no markdown fences:
{
  "title": "deck title",
  "subtitle": "one-line subtitle",
  "slides": [
    {"title": "slide title", "bullets": ["point", "point"], "notes": "what to say"}
  ]
}
