Extract the job posting from the raw page text below.

Hints (may be rough or wrong — verify against the text): title ≈ {{title_hint}}, company ≈ {{company_hint}}.

## Page text
{{page}}

## Rules
- `title`: the job title only (no company, no location, no " - " suffixes).
- `company`: the hiring company's name.
- `location`: city/region if stated, else null.
- `is_remote`: true only if the posting says remote / work-from-anywhere.
- `description`: the actual job description — responsibilities, requirements,
  qualifications, about-the-role. Strip site navigation, cookie banners, footers,
  and "apply" boilerplate. Keep it as clean readable text.
- Do not invent anything not in the page.

## Output
Respond with ONLY valid JSON:
{"title": "...", "company": "...", "location": "... or null", "is_remote": false, "description": "..."}
